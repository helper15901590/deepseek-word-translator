// Content script：悬停取词 + Shadow DOM 弹窗（离开单词自动关闭）
(function () {
  if (window.__dswtInjected) return;
  window.__dswtInjected = true;

  const POPUP_ID = "dswt-popup-host";
  const WORD_CHAR_RE = /[A-Za-z'-]/;
  const CONTEXT_WINDOW = 180;
  const HOVER_DELAY_MS = 500;
  const ACTIVE_MARGIN_PX = 8;
  const IS_TOP_FRAME = window.top === window;
  const TRANSLATION_STATUS_ID = "dswt-translation-status-host";
  const MAX_TRANSLATION_TEXT_CHARS = 5000;
  const LATIN_RE = /[A-Za-z]/;
  const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
  const SKIP_TRANSLATE_SELECTOR = [
    "script", "style", "noscript", "template", "code", "pre", "kbd", "samp",
    "var", "textarea", "input", "select", "option", "svg", "canvas", "math",
    "[contenteditable]:not([contenteditable='false'])", "[aria-hidden='true']",
    "[hidden]",
  ].join(",");
  const BLOCK_TAGS = new Set([
    "P", "LI", "TD", "TH", "H1", "H2", "H3", "H4", "H5", "H6",
    "BLOCKQUOTE", "PRE", "DIV", "ARTICLE", "SECTION", "DD", "DT", "FIGCAPTION",
  ]);
  const ERRORS = {
    NO_KEY: "请点击浏览器工具栏插件图标，填入 DeepSeek API Key",
    AUTH: "API Key 无效或已过期，请在插件面板中更新",
    SERVER: "DeepSeek 服务暂时不可用，请稍后再试",
    NETWORK: "网络请求失败，请检查网络连接",
    PARSE: "释义解析失败，请重试",
  };
  const TRANSLATION_ERRORS = {
    NO_KEY: "请先点击插件图标配置 DeepSeek API Key",
    AUTH: "API Key 无效或已过期，请在插件面板中更新",
    SERVER: "DeepSeek 服务暂时不可用，网页翻译已中断",
    NETWORK: "网络请求失败，网页翻译已中断",
    PARSE: "翻译结果解析失败，网页翻译已中断",
    HTTP: "网页翻译请求失败",
    INVALID: "当前网页没有可翻译的内容",
    NO_CONTENT: "没有找到需要翻译的英文内容",
    BUSY: "网页正在翻译中，请稍候",
  };
  const STYLE_TEXT =
    ".card{font:13px/1.5 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;" +
    "background:#1e1f24;color:#e8e8ea;border-radius:8px;padding:8px 12px;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.35);max-width:320px;" +
    "border:1px solid rgba(255,255,255,.08)}" +
    ".word{font-weight:700;font-size:15px}" +
    ".phonetic{color:#9aa0ab;margin:2px 0 6px}" +
    ".def{margin:2px 0}.pos{color:#7ecbff;margin-right:6px}" +
    ".context{margin-top:6px;padding-top:6px;border-top:1px dashed rgba(128,128,128,.35)}" +
    ".context-label{color:#c792ea;margin-right:6px}" +
    ".muted{color:#9aa0ab}.error{color:#ffb3ab}" +
    "@media (prefers-color-scheme: light){" +
    ".card{background:#fff;color:#1f2328;border-color:rgba(0,0,0,.08);" +
    "box-shadow:0 4px 16px rgba(0,0,0,.18)}" +
    ".phonetic,.muted{color:#6a737d}.pos{color:#0969da}.error{color:#d1242f}" +
    ".context-label{color:#8250df}}";

  let host = null;
  let anchorRange = null;
  let hoverTimer = null;
  let pointerPos = { x: -1, y: -1 };
  let activeWord = null;
  let translatingPage = false;
  let translationStatusHost = null;
  let translationStatusTimer = null;

  function hidePopup() {
    if (!host) return;
    clearTimeout(hoverTimer);
    hoverTimer = null;
    host.remove();
    host = null;
    anchorRange = null;
    activeWord = null;
    document.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("mousedown", onMousedown, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", hidePopup);
  }

  function onKeydown(e) {
    if (e.key === "Escape") hidePopup();
  }

  function onMousedown(e) {
    if (host && !e.composedPath().includes(host)) hidePopup();
  }

  // 指针移入 iframe 后本文档不再收到 mousemove，活跃区域判断不会再触发，
  // 弹窗会滞留在屏幕上；故在指针进入框架元素时直接关闭。
  function onMouseOver(e) {
    const path = e.composedPath ? e.composedPath() : [e.target];
    for (const node of path) {
      if (node && node.tagName === "IFRAME") {
        hidePopup();
        return;
      }
    }
  }

  function isPointInRect(x, y, rect, margin) {
    return (
      x >= rect.left - margin &&
      x <= rect.right + margin &&
      y >= rect.top - margin &&
      y <= rect.bottom + margin
    );
  }

  // 指针是否位于「单词矩形外扩 ∪ 弹窗矩形外扩」活跃区域内
  function isInActiveRegion(x, y) {
    if (!host || !anchorRange) return false;
    return (
      isPointInRect(x, y, anchorRange.getBoundingClientRect(), ACTIVE_MARGIN_PX) ||
      isPointInRect(x, y, host.getBoundingClientRect(), ACTIVE_MARGIN_PX)
    );
  }

  // 滚动时让弹窗跟随锚点单词；单词滚出视口或离开指针则隐藏。
  // scroll 事件可能携带来不及结算的中间位置，故在双 rAF 后用最终位置复查一次。
  let settleCheck = false;
  function checkAnchorPosition() {
    if (!host || !anchorRange) return;
    const r = anchorRange.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) {
      hidePopup();
      return;
    }
    // 滚动时指针不动、单词随页面移动：指针离开单词即关闭
    if (!isPointInRect(pointerPos.x, pointerPos.y, r, ACTIVE_MARGIN_PX)) {
      hidePopup();
      return;
    }
    positionPopup();
  }
  function onScroll() {
    checkAnchorPosition();
    if (settleCheck) return;
    settleCheck = true;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        settleCheck = false;
        checkAnchorPosition();
        // 滚动后指针可能正停在新词上：重新计时
        armHoverTimer();
      })
    );
  }

  // 在指针 (x, y) 处取词；返回 { word, range } 或 null。开放影子根内的文字同样可取值。
  function extractWord(x, y) {
    const caret = DomUtils.caretAtPoint(document, x, y);
    if (!caret) return null;
    const text = caret.node.data;
    let start = caret.offset;
    let end = caret.offset;
    while (start > 0 && WORD_CHAR_RE.test(text[start - 1])) start--;
    while (end < text.length && WORD_CHAR_RE.test(text[end])) end++;
    const w = text.slice(start, end).trim();
    if (!WordUtils.isValidWord(w)) return null;
    const range = document.createRange();
    range.setStart(caret.node, start);
    range.setEnd(caret.node, end);
    return { word: WordUtils.normalizeWord(w), range: range };
  }

  // 提取单词所在文本块、前后各约 CONTEXT_WINDOW 字符的语境；失败返回 null
  function extractContext(range) {
    try {
      const block = DomUtils.findContextBlock(
        range.startContainer,
        BLOCK_TAGS,
        document.body
      );
      if (!block) return null;
      const fullText = block.textContent.replace(/\s+/g, " ").trim();
      if (fullText.length === 0) return null;
      const pre = document.createRange();
      pre.selectNodeContents(block);
      pre.setEnd(range.startContainer, range.startOffset);
      const before = pre.toString().replace(/\s+/g, " ").length;
      const wordLen = Math.max(1, range.toString().length);
      const start = Math.max(0, before - CONTEXT_WINDOW);
      const end = Math.min(fullText.length, before + wordLen + CONTEXT_WINDOW);
      const ctx = fullText.slice(start, end).trim();
      return ctx.length >= 2 ? ctx : null;
    } catch (e) {
      return null;
    }
  }

  // 依据锚点单词当前位置摆放弹窗（视口边界自动翻转）
  function positionPopup() {
    if (!host || !anchorRange) return;
    const rect = anchorRange.getBoundingClientRect();
    const card = host.shadowRoot.querySelector(".card");
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const gap = 6;
    let left = rect.left + rect.width / 2 - cw / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - cw - 4));
    let top = rect.bottom + gap;
    if (top + ch > window.innerHeight - 4 && rect.top - gap - ch > 4) {
      top = rect.top - gap - ch;
    }
    top = Math.max(4, top);
    host.style.left = left + "px";
    host.style.top = top + "px";
  }

  function showPopup(word, range) {
    hidePopup();
    activeWord = word;
    host = document.createElement("div");
    host.id = POPUP_ID;
    host.style.cssText =
      "position:fixed;z-index:2147483647;left:0;top:0;margin:0;padding:0;" +
      "border:0;background:transparent;";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE_TEXT;
    const card = document.createElement("div");
    card.className = "card";
    const wordEl = document.createElement("div");
    wordEl.className = "word";
    wordEl.textContent = word;
    const loadingEl = document.createElement("div");
    loadingEl.className = "muted";
    loadingEl.textContent = "查询中…";
    card.append(wordEl, loadingEl);
    shadow.append(style, card);
    document.documentElement.appendChild(host);
    anchorRange = range.cloneRange();
    positionPopup();
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("mousedown", onMousedown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", hidePopup);
  }

  function renderResult(word, result) {
    if (!host) return;
    const card = host.shadowRoot.querySelector(".card");
    card.textContent = "";
    const wordEl = document.createElement("div");
    wordEl.className = "word";
    wordEl.textContent = word;
    card.appendChild(wordEl);
    if (result && result.ok) {
      const phoneticEl = document.createElement("div");
      phoneticEl.className = "phonetic";
      phoneticEl.textContent = result.data.phonetic;
      card.appendChild(phoneticEl);
      for (const def of result.data.definitions) {
        const defEl = document.createElement("div");
        defEl.className = "def";
        const posEl = document.createElement("span");
        posEl.className = "pos";
        posEl.textContent = def.pos;
        const meaningEl = document.createElement("span");
        meaningEl.textContent = def.meaning;
        defEl.append(posEl, meaningEl);
        card.appendChild(defEl);
      }
      if (result.data.contextMeaning) {
        const ctxEl = document.createElement("div");
        ctxEl.className = "context";
        const labelEl = document.createElement("span");
        labelEl.className = "context-label";
        labelEl.textContent = "语境义";
        const meaningEl = document.createElement("span");
        meaningEl.textContent = result.data.contextMeaning;
        ctxEl.append(labelEl, meaningEl);
        card.appendChild(ctxEl);
      }
      if (result.data.memoryTip) {
        const memEl = document.createElement("div");
        memEl.className = "context";
        const labelEl = document.createElement("span");
        labelEl.className = "context-label";
        labelEl.textContent = "记忆";
        const tipEl = document.createElement("span");
        tipEl.textContent = result.data.memoryTip;
        memEl.append(labelEl, tipEl);
        card.appendChild(memEl);
      }
      if (result.data.plainEnglish) {
        const enEl = document.createElement("div");
        enEl.className = "context";
        const labelEl = document.createElement("span");
        labelEl.className = "context-label";
        labelEl.textContent = "英文释义";
        const textEl = document.createElement("span");
        textEl.textContent = result.data.plainEnglish;
        enEl.append(labelEl, textEl);
        card.appendChild(enEl);
      }
    } else {
      const errEl = document.createElement("div");
      errEl.className = "error";
      const code = result && result.error;
      errEl.textContent =
        ERRORS[code] ||
        (code === "HTTP" ? "请求失败（HTTP " + result.status + "）" : "查询失败，请重试");
      card.appendChild(errEl);
    }
    positionPopup();
  }

  // 停留计时触发：指针位于弹窗上则跳过；同一单词不重复查询
  function onHoverDwell() {
    if (host && isPointInRect(pointerPos.x, pointerPos.y, host.getBoundingClientRect(), 0)) return;
    const found = extractWord(pointerPos.x, pointerPos.y);
    if (!found) return;
    if (host && activeWord === found.word) return;
    const context = extractContext(found.range);
    showPopup(found.word, found.range);
    chrome.runtime
      .sendMessage({ type: "lookup", word: found.word, context: context })
      .then((result) => {
        if (chrome.runtime.lastError || !result) return;
        renderResult(found.word, result);
      })
      .catch(() => {});
  }

  // 每次移动重置停留计时；离开活跃区域则关闭弹窗
  function armHoverTimer() {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      onHoverDwell();
    }, HOVER_DELAY_MS);
  }

  function onMouseMove(e) {
    pointerPos = { x: e.clientX, y: e.clientY };
    if (host && !isInActiveRegion(e.clientX, e.clientY)) hidePopup();
    armHoverTimer();
  }

  function removeTranslationStatus() {
    clearTimeout(translationStatusTimer);
    translationStatusTimer = null;
    if (translationStatusHost) {
      translationStatusHost.remove();
      translationStatusHost = null;
    }
  }

  function showTranslationStatus(message, isError, autoHideMs) {
    clearTimeout(translationStatusTimer);
    if (!translationStatusHost || !translationStatusHost.isConnected) {
      translationStatusHost = document.createElement("div");
      translationStatusHost.id = TRANSLATION_STATUS_ID;
      translationStatusHost.style.cssText =
        "position:fixed;right:16px;bottom:16px;z-index:2147483647;" +
        "margin:0;padding:0;border:0;background:transparent;pointer-events:none;";
      const shadow = translationStatusHost.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent =
        ":host{all:initial}.status{font:13px/1.5 -apple-system,'Segoe UI'," +
        "'Microsoft YaHei',sans-serif;background:#1e1f24;color:#e8e8ea;" +
        "border:1px solid rgba(255,255,255,.12);border-radius:8px;" +
        "padding:8px 12px;box-shadow:0 4px 16px rgba(0,0,0,.3);" +
        "max-width:320px}.status.error{color:#ffb3ab}" +
        "@media(prefers-color-scheme:light){.status{background:#fff;" +
        "color:#1f2328;border-color:rgba(0,0,0,.1);" +
        "box-shadow:0 4px 16px rgba(0,0,0,.18)}.status.error{color:#d1242f}}";
      const status = document.createElement("div");
      status.className = "status";
      shadow.append(style, status);
      document.documentElement.appendChild(translationStatusHost);
    }
    const status = translationStatusHost.shadowRoot.querySelector(".status");
    status.textContent = message;
    status.classList.toggle("error", !!isError);
    if (autoHideMs) {
      translationStatusTimer = setTimeout(() => {
        translationStatusTimer = null;
        removeTranslationStatus();
      }, autoHideMs);
    }
  }

  function shouldSkipTranslationElement(el) {
    if (!el || el === document.documentElement) return true;
    if (DomUtils.closestAcrossBoundaries(el, SKIP_TRANSLATE_SELECTOR)) return true;
    const style = getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    ) {
      return true;
    }
    return el !== document.body && el.getClientRects().length === 0;
  }

  function collectTranslationItems() {
    if (!document.body) return [];
    const items = [];
    const roots = [document.body];
    // 逐层进入开放影子根：TreeWalker 只在单棵树内遍历，不会进入影子树
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      for (const shadowRoot of DomUtils.collectOpenShadowRoots(root)) {
        roots.push(shadowRoot);
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const raw = node.nodeValue;
          if (!raw || !LATIN_RE.test(raw) || CJK_RE.test(raw)) {
            return NodeFilter.FILTER_REJECT;
          }
          const text = raw.trim();
          if (text.length < 2 || text.length > MAX_TRANSLATION_TEXT_CHARS) {
            return NodeFilter.FILTER_REJECT;
          }
          if (shouldSkipTranslationElement(node.parentElement)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let node;
      while ((node = walker.nextNode())) {
        const raw = node.nodeValue;
        const text = raw.trim();
        const start = raw.indexOf(text);
        const range = document.createRange();
        range.selectNodeContents(node);
        let context = extractContext(range);
        if (context && context !== text) {
          const at = context.indexOf(text);
          const contextStart = at > 0 ? Math.max(0, at - 150) : 0;
          context = context.slice(contextStart, contextStart + 400);
        } else {
          context = null;
        }
        items.push({
          node: node,
          text: text,
          context: context,
          leading: raw.slice(0, start),
          trailing: raw.slice(start + text.length),
        });
      }
    }
    return items;
  }

  function applyTranslation(item, translation) {
    if (!item.node.isConnected) return;
    item.node.nodeValue = item.leading + translation + item.trailing;
  }

  function translationErrorMessage(code, status) {
    if (TRANSLATION_ERRORS[code]) return TRANSLATION_ERRORS[code];
    if (code === "HTTP") return "网页翻译请求失败（HTTP " + status + "）";
    return "网页翻译失败，请稍后重试";
  }

  // 本文档内的框架数，用于向 popup 说明页面还有内嵌框架在翻译（嵌套框架会被低估）
  function countChildFrames() {
    return document.querySelectorAll("iframe, frame").length;
  }

  async function translatePage() {
    if (translatingPage) {
      showTranslationStatus(TRANSLATION_ERRORS.BUSY, true, 3000);
      return { ok: false, error: "BUSY" };
    }

    const frames = countChildFrames();
    const items = collectTranslationItems();
    if (items.length === 0) {
      // 子框架无内容时静默：嵌入的广告等框架大多没有可翻译文本
      if (IS_TOP_FRAME) {
        showTranslationStatus(TRANSLATION_ERRORS.NO_CONTENT, true, 4000);
      }
      return { ok: false, error: "NO_CONTENT", frames: frames };
    }

    translatingPage = true;
    let translatedCount = 0;
    showTranslationStatus("正在翻译网页…", false, 0);
    try {
      const batches = PageTranslate.chunkTexts(
        items.map((item) => item.text)
      );
      for (const batch of batches) {
        let result;
        const batchItems = items.slice(
          translatedCount,
          translatedCount + batch.length
        );
        try {
          result = await chrome.runtime.sendMessage({
            type: "translateBatch",
            texts: batch,
            contexts: batchItems.map((item) => item.context || ""),
          });
        } catch (e) {
          result = { ok: false, error: "NETWORK" };
        }
        if (
          !result ||
          !result.ok ||
          !Array.isArray(result.data) ||
          result.data.length !== batch.length
        ) {
          const code = result && result.error ? result.error : "PARSE";
          showTranslationStatus(
            translationErrorMessage(code, result && result.status),
            true,
            5000
          );
          return {
            ok: false,
            error: code,
            translated: translatedCount,
            total: items.length,
            frames: frames,
          };
        }
        for (let i = 0; i < batch.length; i++) {
          applyTranslation(items[translatedCount + i], result.data[i]);
        }
        translatedCount += batch.length;
        showTranslationStatus(
          "正在翻译网页 " +
            translatedCount +
            "/" +
            items.length +
            " 段…",
          false,
          0
        );
      }
      showTranslationStatus(
        "网页翻译完成，共 " + translatedCount + " 段",
        false,
        3500
      );
      return {
        ok: true,
        data: {
          translated: translatedCount,
          total: items.length,
          frames: frames,
        },
      };
    } finally {
      translatingPage = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "translatePage") return;
    // tabs.sendMessage 会广播到页面内所有框架，各框架只翻译自己；
    // 但只有顶层框架回复 popup——多框架同时响应时首个响应者不确定，
    // 某个无内容的子框架先回复会让 popup 显示错误的状态。
    if (!IS_TOP_FRAME) {
      translatePage().catch(() => {});
      return;
    }
    translatePage()
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, error: "NETWORK" }));
    return true; // 异步 sendResponse
  });
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("mouseover", onMouseOver, true);
})();
