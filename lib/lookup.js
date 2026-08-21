// 提示词构建、DeepSeek 响应解析、lookup 流程（background / Node 测试共用）
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Lookup = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const SYSTEM_PROMPT =
    "你是英汉词典。仅输出 JSON，不输出任何其他文字、解释或 markdown 代码块。";

  function buildMessages(word, context) {
    const hasContext = typeof context === "string" && context.trim() !== "";
    const userContent = hasContext
      ? '给出单词 "' + word + '" 的音标和 1~3 条最常用中文释义。该词出现的语境："' +
        context.trim() +
        '"。"contextMeaning" 请给出结合该语境、该词在此处的准确中文含义（一句话）。"memoryTip" 请给出一句话快速记忆该单词的方法（如词根拆解、谐音联想或场景联想，中文）。严格按此格式输出：' +
        '{"phonetic":"<IPA音标>","definitions":[{"pos":"<词性缩写，如 n./v./adj./adv.>","meaning":"<中文释义>"}],"contextMeaning":"<结合语境的一句话中文含义>","memoryTip":"<一句话快速记忆方法>"}'
      : '给出单词 "' + word + '" 的音标和 1~3 条最常用中文释义。严格按此格式输出：' +
        '{"phonetic":"<IPA音标>","definitions":[{"pos":"<词性缩写，如 n./v./adj./adv.>","meaning":"<中文释义>"}],"memoryTip":"<一句话快速记忆方法>"}';
    return [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ];
  }

  function stripCodeFences(text) {
    return text
      .replace(/```(?:json)?\s*/gi, "")
      .replace(/```/g, "")
      .trim();
  }

  function extractJsonObject(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    return text.slice(start, end + 1);
  }

  // FNV-1a 32 位哈希（缓存键用，稳定跨会话）
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }

  // 无语境 → 纯单词键；有语境 → word|hash(context)
  function makeContextKey(word, context) {
    if (typeof context !== "string" || context.trim() === "") return word;
    return word + "|" + fnv1a(context);
  }

  // 返回 { ok:true, data:{word,phonetic,definitions,contextMeaning,memoryTip} } 或 { ok:false, error:"PARSE" }
  function parseLookupResponse(text, word) {
    if (typeof text !== "string" || text.trim() === "") {
      return { ok: false, error: "PARSE" };
    }
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (e) {
      const json = extractJsonObject(stripCodeFences(text));
      if (!json) return { ok: false, error: "PARSE" };
      try {
        data = JSON.parse(json);
      } catch (e2) {
        return { ok: false, error: "PARSE" };
      }
    }
    if (typeof data !== "object" || data === null) {
      return { ok: false, error: "PARSE" };
    }
    if (typeof data.phonetic !== "string" || data.phonetic.trim() === "") {
      return { ok: false, error: "PARSE" };
    }
    if (!Array.isArray(data.definitions)) return { ok: false, error: "PARSE" };
    const definitions = [];
    for (const d of data.definitions.slice(0, 3)) {
      if (
        d &&
        typeof d === "object" &&
        typeof d.pos === "string" &&
        typeof d.meaning === "string" &&
        d.meaning.trim() !== ""
      ) {
        definitions.push({ pos: d.pos.trim(), meaning: d.meaning.trim() });
      }
    }
    if (definitions.length === 0) return { ok: false, error: "PARSE" };
    const contextMeaning =
      typeof data.contextMeaning === "string" && data.contextMeaning.trim() !== ""
        ? data.contextMeaning.trim()
        : null;
    const memoryTip =
      typeof data.memoryTip === "string" && data.memoryTip.trim() !== ""
        ? data.memoryTip.trim()
        : null;
    return {
      ok: true,
      data: {
        word: word,
        phonetic: data.phonetic.trim(),
        definitions: definitions,
        contextMeaning: contextMeaning,
        memoryTip: memoryTip,
      },
    };
  }

  // 依赖注入：deps.getApiKey / deps.requestJson / deps.cache{get,set} / deps.makeKey(word, context)
  function createLookup(deps) {
    return async function lookup(word, context) {
      if (typeof word !== "string" || word.length === 0) {
        return { ok: false, error: "INVALID" };
      }
      const key = deps.makeKey(word, context);
      const cached = deps.cache.get(key);
      if (cached) return { ok: true, data: cached };

      const apiKey = await deps.getApiKey();
      if (!apiKey) return { ok: false, error: "NO_KEY" };

      let resp;
      try {
        resp = await deps.requestJson(buildMessages(word, context));
      } catch (e) {
        return { ok: false, error: "NETWORK" };
      }
      if (resp.status === 401) return { ok: false, error: "AUTH" };
      if (resp.status === 429 || resp.status >= 500) {
        return { ok: false, error: "SERVER" };
      }
      if (resp.status !== 200 || !resp.json) {
        return { ok: false, error: "HTTP", status: resp.status };
      }
      const content =
        resp.json.choices &&
        resp.json.choices[0] &&
        resp.json.choices[0].message
          ? resp.json.choices[0].message.content
          : null;
      const parsed = parseLookupResponse(content, word);
      if (!parsed.ok) return parsed;
      deps.cache.set(key, parsed.data);
      return parsed;
    };
  }

  return {
    SYSTEM_PROMPT,
    buildMessages,
    stripCodeFences,
    extractJsonObject,
    parseLookupResponse,
    createLookup,
    makeContextKey,
  };
});
