# Memory Tip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在弹窗「语境义」行下方（无语境时在释义列表下方）新增一行「记忆」，显示 DeepSeek 生成的一句话快速记忆方法。

**Architecture:** 与现有 `contextMeaning` 完全同构：同一次 DeepSeek 调用，`buildMessages` 的两个 user 模板的 JSON 格式增加可选字段 `memoryTip`；`parseLookupResponse` 按可选字段解析（缺失/空白/非字符串 → `null`）；`content.js:renderResult` 在语境义之后、错误分支之前追加「记忆」行；缓存键不变，旧缓存条目天然兼容（渲染按 `null` 隐藏该行）。

**Tech Stack:** 零依赖原生 JS（Chrome MV3 classic scripts）；测试 Node `node:test` + `node:assert`（CommonJS）。

## Global Constraints

- 零外部依赖：不新增任何包、不引入 `package.json`。
- `lib/*.js` 保持 UMD（`globalThis` + `module.exports`），禁止 `chrome.*` 引用。
- 单元测试：`node --test`（默认发现 `tests/*.test.js`；`node --test tests/` 目录形式在本环境不可用），全绿；测试名用中文描述句。
- 提交信息前缀：`feat:` / `fix:` / `test:` / `docs:`，英文，祈使句。
- 渲染一律 `textContent`，禁止 `innerHTML`（防 XSS）。
- 数据形状：`data.memoryTip: string|null`；解析失败不因此字段失败（可选字段）。
- 缓存键 `makeContextKey(word, context)` 不变；`lookupCache_v1` 存储键不变。

---

### Task 1: 提示词与解析支持 memoryTip

**Files:**
- Modify: `lib/lookup.js` — `buildMessages` 两个模板、`parseLookupResponse`
- Test: `tests/lookup.test.js`

**Interfaces:**
- Consumes: 现有 `buildMessages(word, context)` 返回 `[{role,content},...]`；`parseLookupResponse(text, word)` 返回 `{ok:true,data}`。
- Produces: `data` 增加 `memoryTip: string|null`（trim 后非空字符串或 `null`）；user 消息内容包含 `"memoryTip"`（有语境与无语境模板均含）。

- [ ] **Step 1: 写失败测试**

在 `tests/lookup.test.js` 修改 fixtures 与用例：

```js
const GOOD_CTX =
  '{"phonetic":"/test/","definitions":[{"pos":"n.","meaning":"测试"}],"contextMeaning":"此处指软件测试","memoryTip":"拆解 test 联想“测试”"}';
```

修改「buildMessages 无语境」用例（末尾追加一条断言）：

```js
assert.ok(msgs[1].content.includes("memoryTip"));
```

修改「buildMessages 有语境」用例（追加）：

```js
assert.ok(msgs[1].content.includes("memoryTip"));
```

修改「解析干净 JSON」用例（追加）：

```js
assert.equal(r.data.memoryTip, null);
```

修改「解析含 contextMeaning 的 JSON」用例（追加）：

```js
assert.equal(r.data.memoryTip, "拆解 test 联想“测试”");
```

新增用例（仿照 contextMeaning 的空/非字符串用例）：

```js
test("memoryTip 为空字符串/缺失/非字符串时置 null", () => {
  const r1 = parseLookupResponse(
    '{"phonetic":"/t/","definitions":[{"pos":"n.","meaning":"一"}],"memoryTip":""}',
    "t"
  );
  assert.equal(r1.ok, true);
  assert.equal(r1.data.memoryTip, null);
  const r2 = parseLookupResponse(
    '{"phonetic":"/t/","definitions":[{"pos":"n.","meaning":"一"}],"memoryTip":42}',
    "t"
  );
  assert.equal(r2.ok, true);
  assert.equal(r2.data.memoryTip, null);
});
```

修改「createLookup：成功结果写入缓存并返回（含语境义）」用例（在 `r.data.contextMeaning` 断言后追加）：

```js
assert.equal(r.data.memoryTip, "拆解 test 联想“测试”");
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/`
Expected: FAIL——`buildMessages` 的 `includes("memoryTip")` 断言失败；`parseLookupResponse` 的 `r.data.memoryTip` 为 `undefined`，`assert.equal(undefined, null)` 失败。

- [ ] **Step 3: 实现最小代码**

`lib/lookup.js` 的 `buildMessages`，有语境模板整段替换为：

```js
    const userContent = hasContext
      ? '给出单词 "' + word + '" 的音标和 1~3 条最常用中文释义。该词出现的语境："' +
        context.trim() +
        '"。"contextMeaning" 请给出结合该语境、该词在此处的准确中文含义（一句话）。"memoryTip" 请给出一句话快速记忆该单词的方法（如词根拆解、谐音联想或场景联想，中文）。严格按此格式输出：' +
        '{"phonetic":"<IPA音标>","definitions":[{"pos":"<词性缩写，如 n./v./adj./adv.>","meaning":"<中文释义>"}],"contextMeaning":"<结合语境的一句话中文含义>","memoryTip":"<一句话快速记忆方法>"}'
      : '给出单词 "' + word + '" 的音标和 1~3 条最常用中文释义。严格按此格式输出：' +
        '{"phonetic":"<IPA音标>","definitions":[{"pos":"<词性缩写，如 n./v./adj./adv.>","meaning":"<中文释义>"}],"memoryTip":"<一句话快速记忆方法>"}';
```

`parseLookupResponse` 在 `const contextMeaning = ...` 块之后追加：

```js
    const memoryTip =
      typeof data.memoryTip === "string" && data.memoryTip.trim() !== ""
        ? data.memoryTip.trim()
        : null;
```

并在 `return` 的 `data` 对象中 `contextMeaning: contextMeaning,` 之后追加：

```js
        memoryTip: memoryTip,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/`
Expected: PASS，全部测试通过。

- [ ] **Step 5: 提交**

```bash
git add lib/lookup.js tests/lookup.test.js
git commit -m "feat: add memoryTip field to lookup prompt and parser"
```

---

### Task 2: 弹窗渲染「记忆」行

**Files:**
- Modify: `content.js` — `renderResult`

**Interfaces:**
- Consumes: Task 1 的 `result.data.memoryTip: string|null`。
- Produces: 弹窗卡片中，「语境义」行下方（无语境时在释义列表下方）追加 `.context` 样式块，标签「记忆」。

- [ ] **Step 1: 语法基线检查**

Run: `node --check content.js`
Expected: 无输出（语法正确）。此步骤无单元测试（content.js 无 Node 测试基建，渲染验证走 Task 3 e2e）。

- [ ] **Step 2: 实现渲染**

在 `renderResult` 中 `if (result.data.contextMeaning) { ... }` 块结束（`}`）之后、`} else {` 之前插入：

```js
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
```

- [ ] **Step 3: 语法检查**

Run: `node --check content.js`
Expected: 无输出。

- [ ] **Step 4: 提交**

```bash
git add content.js
git commit -m "feat: render memory tip row below context meaning"
```

---

### Task 3: E2E 证据更新

**Files:**
- Modify: `e2e/e2e-happy.png`

**Interfaces:**
- Consumes: Task 2 的渲染结果；`e2e/serve.js`（127.0.0.1:8123）；Chrome + `--load-extension=<repo root>`。

- [ ] **Step 1: 启动测试服务器**

Run: `node e2e/serve.js`
Expected: 输出 `test server ready: http://127.0.0.1:8123/test-page.html`。

- [ ] **Step 2: 启动 Chrome 加载扩展并打开测试页**

Chrome 参数 `--load-extension=D:/work_space/AI/deepseek-word-translator`；打开 `http://127.0.0.1:8123/test-page.html`。在扩展 popup 页（`chrome-extension://<id>/popup.html`）执行 `chrome.storage.local.set({apiKey:'sk-e2e'})`（仅本地测试环境）；用 CDP Fetch 拦截 service worker 目标上 `https://api.deepseek.com/*` 请求，返回伪造的 chat-completions JSON（choices[0].message.content 为含 `memoryTip` 的合法 JSON，如 `{"phonetic":"/ˌserənˈdɪpəti/","definitions":[{"pos":"n.","meaning":"机缘巧合"}],"contextMeaning":"此处指意外发现美好事物的能力","memoryTip":"谐音“塞壬的派对”：意外撞见海妖的快乐派对"}`）。

- [ ] **Step 3: 双击取词并截图**

双击 `serendipity`；确认弹窗出现音标、释义、语境义与「记忆」行；截图保存为 `e2e/e2e-happy.png`（覆盖旧图）。
Expected: 截图可见「记忆」行及其内容。

- [ ] **Step 4: 提交**

```bash
git add e2e/e2e-happy.png
git commit -m "test: update e2e screenshot with memory tip row"
```

---

### Task 4: 设计文档修订记录

**Files:**
- Modify: `docs/superpowers/specs/2026-08-20-deepseek-word-translator-design.md`

- [ ] **Step 1: 追加修订条目**（第 11 节修订记录末尾）

```markdown
5. **快速记忆行**：提示词 JSON 增加可选字段 `memoryTip`（一句话快速记忆该单词的方法，中文，如词根拆解/谐音/场景联想）；解析规则与 `contextMeaning` 一致（缺失/空白/非字符串 → `null`）；弹窗在「语境义」行下方（无语境时在释义列表下方）新增「记忆」行，字段为 `null` 时不渲染该行；缓存键不变，旧缓存条目无该字段即隐藏此行，无需迁移。
```

- [ ] **Step 2: 提交**

```bash
git add docs/superpowers/specs/2026-08-20-deepseek-word-translator-design.md
git commit -m "docs: record memory tip feature in design spec"
```
