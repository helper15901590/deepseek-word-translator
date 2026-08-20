// 提示词构建、DeepSeek 响应解析、lookup 流程（background / Node 测试共用）
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Lookup = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const SYSTEM_PROMPT =
    "你是英汉词典。仅输出 JSON，不输出任何其他文字、解释或 markdown 代码块。";

  function buildMessages(word) {
    return [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          '给出单词 "' + word + '" 的音标和 1~3 条最常用中文释义。严格按此格式输出：' +
          '{"phonetic":"<IPA音标>","definitions":[{"pos":"<词性缩写，如 n./v./adj./adv.>","meaning":"<中文释义>"}]}',
      },
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

  // 返回 { ok:true, data:{word,phonetic,definitions} } 或 { ok:false, error:"PARSE" }
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
    return {
      ok: true,
      data: {
        word: word,
        phonetic: data.phonetic.trim(),
        definitions: definitions,
      },
    };
  }

  // 依赖注入：deps.getApiKey / deps.requestJson / deps.cache{get,set}
  function createLookup(deps) {
    return async function lookup(word) {
      if (typeof word !== "string" || word.length === 0) {
        return { ok: false, error: "INVALID" };
      }
      const cached = deps.cache.get(word);
      if (cached) return { ok: true, data: cached };

      const apiKey = await deps.getApiKey();
      if (!apiKey) return { ok: false, error: "NO_KEY" };

      let resp;
      try {
        resp = await deps.requestJson(buildMessages(word));
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
      deps.cache.set(word, parsed.data);
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
  };
});
