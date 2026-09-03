# Hover Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 双击取词改为鼠标悬停单词停留 500ms 取词；指针离开「单词∪弹窗」活跃区域自动关闭弹窗。

**Architecture:** 仅改 `content.js`：删除 `dblclick` 监听器，新增常驻 `mousemove` 监听器（每次移动重置 500ms 停留计时，`HOVER_DELAY_MS = 500`）；计时触发时用 `document.caretRangeFromPoint` 在指针处取词（删除 selection 分支）；关闭语义改为「指针离开活跃区域即关」——活跃区域 = 单词矩形外扩 `ACTIVE_MARGIN_PX = 8` ∪ 弹窗 host 矩形外扩 8；`checkAnchorPosition` 增加指针离词判断，滚动双 rAF 复查后重新计时；同一单词停留不重复查询（`activeWord` 去重）。`lib/*`、`background.js`、`popup.js` 不动。

**Tech Stack:** 零依赖原生 JS（Chrome MV3 classic scripts）；测试 Node `node:test` + `node:assert`（CommonJS）。

**说明:** 设计文档修订 #7 已写入 `docs/superpowers/specs/2026-08-20-deepseek-word-translator-design.md`（随本计划一同提交）。

## Global Constraints

- 零外部依赖：不新增任何包、不引入 `package.json`。
- `lib/*.js` 保持 UMD（`globalThis` + `module.exports`），禁止 `chrome.*` 引用。
- 单元测试：`node --test`（默认发现 `tests/*.test.js`；`node --test tests/` 目录形式在本环境不可用），全绿；测试名用中文描述句。
- 提交信息前缀：`feat:` / `fix:` / `test:` / `docs:`，英文，祈使句。
- 渲染一律 `textContent`，禁止 `innerHTML`（防 XSS）。
- 消息协议不变：`{type:'lookup', word, context}`；`HOVER_DELAY_MS = 500`，活跃区域外扩 `ACTIVE_MARGIN_PX = 8`。
- content.js 无 Node 测试基建 → 渲染/交互验证走 Task 3 浏览器烟测。
- 双击彻底移除，不保留兼容路径。

---

### Task 1: content.js 悬停触发与自动关闭

**Files:**
- Modify: `content.js`（整文件重写）

**Interfaces:**
- Consumes: `WordUtils.isValidWord` / `WordUtils.normalizeWord`（`lib/word.js` 全局）；`chrome.runtime.sendMessage({type:'lookup', word, context})`。
- Produces: 常量 `HOVER_DELAY_MS = 500`、`ACTIVE_MARGIN_PX = 8`；状态 `hoverTimer`、`pointerPos`、`activeWord`；函数 `armHoverTimer`、`onHoverDwell`、`onMouseMove`、`isPointInRect`、`isInActiveRegion`；`extractWord(x, y)` 改为纯坐标取词。

- [ ] **Step 1: 语法基线检查**

Run: `node --check content.js`
Expected: 无输出（语法正确）。

- [ ] **Step 2: 整文件重写 content.js**

```js
// Content script：悬停取词 + Shadow DOM 弹窗（离开单词自动关闭）
(function () {
  if (window.__dswtInjected) return;
  window.__dswtInjected = true;

  const POPUP_ID = "dswt-popup-host";
  const WORD_CHAR_RE = /[A-Za-z'-]/;
  const CONTEXT_WINDOW = 180;
  const HOVER_DELAY_MS = 500;
  const ACTIVE_MARGIN_PX = 8;
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
  let hoverTimer = null;
  let pointerPos = { x: -1, y: -1 };
  let activeWord = null;

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

  // 在指针 (x, y) 处取词；返回 { word, range } 或 null
  function extractWord(x, y) {
    if (document.caretRangeFromPoint) {
      const caret = document.caretRangeFromPoint(x, y);
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

  document.addEventListener("mousemove", onMouseMove, true);
})();
```

- [ ] **Step 3: 语法检查**

Run: `node --check content.js`
Expected: 无输出。

- [ ] **Step 4: 单元测试回归**

Run: `node --test`
Expected: PASS 28（lib 未动，应全绿）。

- [ ] **Step 5: 提交**

```bash
git add content.js
git commit -m "feat: trigger lookup on 500ms hover with auto-close"
```

---

### Task 2: 文案与文档同步

**Files:**
- Modify: `manifest.json`（description）
- Modify: `AGENTS.md`（overview、lookup flow 步骤 1、E2E 说明）

**Interfaces:**
- Consumes: Task 1 的悬停行为。
- Produces: 所有面向用户的「双击」文案统一为「悬停」。

- [ ] **Step 1: 改 manifest description**

`manifest.json` 中：

```json
"description": "双击英文单词，显示音标与中文释义（由 DeepSeek 驱动）"
```

改为：

```json
"description": "悬停英文单词 500ms，显示音标与中文释义（由 DeepSeek 驱动）"
```

- [ ] **Step 2: 改 AGENTS.md 三处**

Overview 段：`double-click an English word on any page and a Shadow-DOM popup shows` → `hover over an English word on any page for 500ms and a Shadow-DOM popup shows`。

Lookup flow 步骤 1：`\`dblclick\` → \`content.js\` extracts the word (selection, fallback \`caretRangeFromPoint\`) and ±180 chars of context, shows a "查询中…" Shadow-DOM card pinned to the word.` → `\`mousemove\` dwell (500ms) → \`content.js\` extracts the word via \`caretRangeFromPoint\` at the pointer and ±180 chars of context, shows a "查询中…" Shadow-DOM card pinned to the word; the popup closes when the pointer leaves the word/popup active region, on scroll, or via Esc/click.`

E2E 行：`double-click English words (\`serendipity\`, \`ubiquitous\`, \`meticulous\`) → popup appears; double-click Chinese text → must NOT trigger; record evidence as \`e2e/e2e-happy.png\`` → `hover English words (\`serendipity\`, \`ubiquitous\`, \`meticulous\`) for 500ms → popup appears; moving the pointer away closes it; hovering Chinese text → must NOT trigger; record evidence as \`e2e/e2e-hover.png\``。

- [ ] **Step 3: manifest 校验**

Run: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"`
Expected: 无输出（JSON 合法）。

- [ ] **Step 4: 提交**

```bash
git add manifest.json AGENTS.md
git commit -m "docs: update trigger wording for hover in manifest and guidelines"
```

---

### Task 3: E2E 烟测与证据

**Files:**
- Create: `e2e/e2e-hover.png`（新证据，不覆盖 `e2e/e2e-happy.png`）

**Interfaces:**
- Consumes: Task 1 的悬停行为；`e2e/serve.js`（127.0.0.1:8123）；Chrome `--headless=new --load-extension=<repo root>`。

- [ ] **Step 1: 启动测试服务器**

Run: `node e2e/serve.js`
Expected: 输出 `test server ready: http://127.0.0.1:8123/test-page.html`。

- [ ] **Step 2: 无 Key 场景验证触发与关闭**

自动化浏览器打开 `http://127.0.0.1:8123/test-page.html`，用 `page.mouse.move` 悬停 `serendipity` 中心：
- 悬停 ≥500ms：页面出现 `#dswt-popup-host`，卡片含 `serendipity` 与 NO_KEY 提示「请点击浏览器工具栏插件图标，填入 DeepSeek API Key」。
- 快速划过（每词 <500ms）：不出现 host。
- 悬停中文段落：不出现 host。
- 悬停后移开到空白处：host 消失。

- [ ] **Step 3: 拦截伪造响应截图**

在扩展 popup 页执行 `chrome.storage.local.set({apiKey:'sk-e2e'})`；用 CDP Fetch 拦截 service worker 目标上 `https://api.deepseek.com/*` 请求，返回伪造的 chat-completions JSON（`choices[0].message.content` 为 `{"phonetic":"/ˌserənˈdɪpəti/","definitions":[{"pos":"n.","meaning":"机缘巧合"}],"contextMeaning":"此处指意外发现美好事物的能力","memoryTip":"谐音联想：塞壬的派对","plainEnglish":"A lucky discovery that happens by chance"}`）。悬停 `serendipity` 500ms，确认弹窗显示音标、释义、语境义、记忆、英文释义，截图保存为 `e2e/e2e-hover.png`。

- [ ] **Step 4: 提交**

```bash
git add e2e/e2e-hover.png
git commit -m "test: add hover e2e screenshot evidence"
```

---

### Task 4: 设计文档修订记录（已完成，随 docs 提交）

**Files:**
- Modify: `docs/superpowers/specs/2026-08-20-deepseek-word-translator-design.md`

修订 #7 已写入（触发方式、数据流步骤 1/2/8、§5 关闭语义、§7/§9 文案、修订记录）。提交：

```bash
git add docs/superpowers/specs/2026-08-20-deepseek-word-translator-design.md docs/superpowers/plans/2026-09-03-hover-trigger.md
git commit -m "docs: record hover trigger revision and implementation plan"
```
