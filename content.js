// Content script：双击取词 + Shadow DOM 弹窗
(function () {
  if (window.__dswtInjected) return;
  window.__dswtInjected = true;

  const POPUP_ID = "dswt-popup-host";
  const WORD_CHAR_RE = /[A-Za-z'-]/;
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
    ".phonetic{color:#9aa0ab;font-style:italic;margin:2px 0 6px}" +
    ".def{margin:2px 0}.pos{color:#7ecbff;margin-right:6px}" +
    ".muted{color:#9aa0ab}.error{color:#ffb3ab}" +
    "@media (prefers-color-scheme: light){" +
    ".card{background:#fff;color:#1f2328;border-color:rgba(0,0,0,.08);" +
    "box-shadow:0 4px 16px rgba(0,0,0,.18)}" +
    ".phonetic,.muted{color:#6a737d}.pos{color:#0969da}.error{color:#d1242f}}";

  let host = null;

  function hidePopup() {
    if (!host) return;
    host.remove();
    host = null;
    document.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("mousedown", onMousedown, true);
    window.removeEventListener("scroll", hidePopup, true);
    window.removeEventListener("resize", hidePopup);
  }

  function onKeydown(e) {
    if (e.key === "Escape") hidePopup();
  }

  function onMousedown(e) {
    if (host && !e.composedPath().includes(host)) hidePopup();
  }

  function extractWord(e) {
    const sel = window.getSelection();
    const selText = sel ? sel.toString().trim() : "";
    if (selText && WordUtils.isValidWord(selText)) {
      return WordUtils.normalizeWord(selText);
    }
    if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (range && range.startContainer.nodeType === Node.TEXT_NODE) {
        const text = range.startContainer.data;
        let start = range.startOffset;
        let end = range.endOffset;
        while (start > 0 && WORD_CHAR_RE.test(text[start - 1])) start--;
        while (end < text.length && WORD_CHAR_RE.test(text[end])) end++;
        const w = text.slice(start, end).trim();
        if (WordUtils.isValidWord(w)) return WordUtils.normalizeWord(w);
      }
    }
    return null;
  }

  function getRect(e) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (r && (r.width || r.height)) return r;
    }
    if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (range) {
        const r = range.getBoundingClientRect();
        if (r && (r.width || r.height)) return r;
      }
    }
    return {
      left: e.clientX,
      top: e.clientY,
      right: e.clientX,
      bottom: e.clientY,
      width: 0,
      height: 0,
    };
  }

  function positionPopup(rect) {
    if (!host) return;
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

  function showPopup(rect, word) {
    hidePopup();
    host = document.createElement("div");
    host.id = POPUP_ID;
    host.style.cssText =
      "position:absolute;z-index:2147483647;left:0;top:0;margin:0;padding:0;" +
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
    positionPopup(rect);
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("mousedown", onMousedown, true);
    window.addEventListener("scroll", hidePopup, true);
    window.addEventListener("resize", hidePopup);
  }

  function renderResult(rect, word, result) {
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
    } else {
      const errEl = document.createElement("div");
      errEl.className = "error";
      const code = result && result.error;
      errEl.textContent =
        ERRORS[code] ||
        (code === "HTTP" ? "请求失败（HTTP " + result.status + "）" : "查询失败，请重试");
      card.appendChild(errEl);
    }
    positionPopup(rect);
  }

  document.addEventListener("dblclick", (e) => {
    if (e.target && e.target.closest && e.target.closest("#" + POPUP_ID)) return;
    const word = extractWord(e);
    if (!word) return;
    const rect = getRect(e);
    showPopup(rect, word);
    chrome.runtime
      .sendMessage({ type: "lookup", word: word })
      .then((result) => {
        if (chrome.runtime.lastError || !result) return;
        renderResult(rect, word, result);
      })
      .catch(() => {});
  });
})();
