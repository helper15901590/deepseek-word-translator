// Content script：双击取词 + Shadow DOM 弹窗（弹窗跟随单词滚动）
(function () {
  if (window.__dswtInjected) return;
  window.__dswtInjected = true;

  const POPUP_ID = "dswt-popup-host";
  const WORD_CHAR_RE = /[A-Za-z'-]/;
  const CONTEXT_WINDOW = 180;
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

  function hidePopup() {
    if (!host) return;
    host.remove();
    host = null;
    anchorRange = null;
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

  // 滚动时让弹窗跟随锚点单词；单词滚出视口则隐藏。
  // scroll 事件可能携带来不及结算的中间位置，故在双 rAF 后用最终位置复查一次。
  let settleCheck = false;
  function checkAnchorPosition() {
    if (!host || !anchorRange) return;
    const r = anchorRange.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) {
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
      })
    );
  }
  // 返回 { word, range } 或 null
  function extractWord(e) {
    const sel = window.getSelection();
    const selText = sel ? sel.toString().trim() : "";
    if (selText && WordUtils.isValidWord(selText) && sel.rangeCount > 0) {
      return {
        word: WordUtils.normalizeWord(selText),
        range: sel.getRangeAt(0).cloneRange(),
      };
    }
    if (document.caretRangeFromPoint) {
      const caret = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (caret && caret.startContainer.nodeType === Node.TEXT_NODE) {
        const text = caret.startContainer.data;
        let start = caret.startOffset;
        let end = caret.endOffset;
        while (start > 0 && WORD_CHAR_RE.test(text[start - 1])) start--;
        while (end < text.length && WORD_CHAR_RE.test(text[end])) end++;
        const w = text.slice(start, end).trim();
        if (WordUtils.isValidWord(w)) {
          const range = document.createRange();
          range.setStart(caret.startContainer, start);
          range.setEnd(caret.startContainer, end);
          return { word: WordUtils.normalizeWord(w), range: range };
        }
      }
    }
    return null;
  }

  // 提取单词所在文本块、前后各约 CONTEXT_WINDOW 字符的语境；失败返回 null
  function extractContext(range) {
    try {
      let el =
        range.startContainer.nodeType === Node.TEXT_NODE
          ? range.startContainer.parentElement
          : range.startContainer;
      while (el && el !== document.body && !BLOCK_TAGS.has(el.tagName)) {
        el = el.parentElement;
      }
      const block = el || document.body;
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

  document.addEventListener("dblclick", (e) => {
    if (e.target && e.target.closest && e.target.closest("#" + POPUP_ID)) return;
    const found = extractWord(e);
    if (!found) return;
    const context = extractContext(found.range);
    showPopup(found.word, found.range);
    chrome.runtime
      .sendMessage({ type: "lookup", word: found.word, context: context })
      .then((result) => {
        if (chrome.runtime.lastError || !result) return;
        renderResult(found.word, result);
      })
      .catch(() => {});
  });
})();
