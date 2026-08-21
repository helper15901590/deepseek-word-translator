# Plain English Explanation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在弹窗「记忆」行下方新增一行「英文释义」，用一句简单易懂的英文解释单词意思。

**Architecture:** 与 `memoryTip` 完全同构：同一次 DeepSeek 调用，`buildMessages` 两个 user 模板的 JSON 格式增加可选字段 `plainEnglish`；`parseLookupResponse` 按可选字段解析（缺失/空白/非字符串 → `null`）；`content.js:renderResult` 在记忆行之后追加「英文释义」行；缓存键不变，旧缓存条目天然兼容（渲染按 `null` 隐藏该行）。

**Tech Stack:** 零依赖原生 JS（Chrome MV3 classic scripts）；测试 Node `node:test` + `node:assert`（CommonJS）。

## Global Constraints

- 零外部依赖：不新增任何包、不引入 `package.json`。
- `lib/*.js` 保持 UMD（`globalThis` + `module.exports`），禁止 `chrome.*` 引用。
- 渲染一律 `textContent`，禁止 `innerHTML`（防 XSS）。
- 提交信息前缀：`feat:` / `fix:` / `test:` / `docs:`，英文，祈使句。
- 单元测试：`node --test`（默认发现 `tests/*.test.js`），全绿；测试名用中文描述句。
- 数据形状：`data.plainEnglish: string|null`；解析失败不因此字段失败（可选字段）。
- 缓存键 `makeContextKey(word, context)` 不变；`lookupCache_v1` 存储键不变。

---

### Task 1: 提示词与解析支持 plainEnglish

**Files:**
- Modify: `lib/lookup.js` — `buildMessages` 两个模板、`parseLookupResponse`
- Test: `tests/lookup.test.js`

**Interfaces:**
- Consumes: `buildMessages(word, context)` 返回 `[{role,content},...]`；`parseLookupResponse(text, word)` 返回 `{ok:true,data}`。
- Produces: `data` 增加 `plainEnglish: string|null`；user 消息内容包含 `"plainEnglish"`（两个模板均含）。

- [ ] **Step 1: 写失败测试**

`tests/lookup.test.js` 的 `GOOD_CTX` fixture 追加字段：

```js
const GOOD_CTX =
  '{"phonetic":"/test/","definitions":[{"pos":"n.","meaning":"测试"}],"contextMeaning":"此处指软件测试","memoryTip":"拆解 test 联想“测试”","plainEnglish":"A trial to check that something works"}';
```

在以下用例追加断言 `assert.ok(msgs[1].content.includes("plainEnglish"));`：
- `buildMessages 无语境：两条消息且不含语境说明`
- `buildMessages 有语境：user 消息包含语境文本与 contextMeaning 要求`

在「解析干净 JSON」用例追加：

```js
assert.equal(r.data.plainEnglish, null);
```

在「解析含 contextMeaning 的 JSON」用例追加：

```js
assert.equal(r.data.plainEnglish, "A trial to check that something works");
```

新增用例（仿照 memoryTip 的空/非字符串用例）：

```js
test("plainEnglish 为空字符串/缺失/非字符串时置 null", () => {
  const r1 = parseLookupResponse(
    '{"phonetic":"/t/","definitions":[{"pos":"n.","meaning":"一"}],"plainEnglish":""}',
    "t"
  );
  assert.equal(r1.ok, true);
  assert.equal(r1.data.plainEnglish, null);
  const r2 = parseLookupResponse(
    '{"phonetic":"/t/","definitions":[{"pos":"n.","meaning":"一"}],"plainEnglish":42}',
    "t"
  );
  assert.equal(r2.ok, true);
  assert.equal(r2.data.plainEnglish, null);
});
```

在「createLookup：成功结果写入缓存并返回（含语境义）」用例追加：

```js
assert.equal(r.data.plainEnglish, "A trial to check that something works");
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test`
Expected: FAIL——`buildMessages` 的 `includes("plainEnglish")` 断言失败（×2）；`parseLookupResponse` 与 `createLookup` 的 `r.data.plainEnglish` 为 `undefined`（×2）。

- [ ] **Step 3: 实现最小代码**

`lib/lookup.js` 的 `buildMessages` 两个模板替换为：

```js
    const userContent = hasContext
      ? '给出单词 "' + word + '" 的音标和 1~3 条最常用中文释义。该词出现的语境："' +
        context.trim() +
        '"。"contextMeaning" 请给出结合该语境、该词在此处的准确中文含义（一句话）。"memoryTip" 请给出一句话快速记忆该单词的方法（如词根拆解、谐音联想或场景联想，中文）。"plainEnglish" 请用一句简单易懂的英文解释该单词在此处的意思（适合英语学习者）。严格按此格式输出：' +
        '{"phonetic":"<IPA音标>","definitions":[{"pos":"<词性缩写，如 n./v./adj./adv.>","meaning":"<中文释义>"}],"contextMeaning":"<结合语境的一句话中文含义>","memoryTip":"<一句话快速记忆方法>","plainEnglish":"<一句简单易懂的英文释义>"}'
      : '给出单词 "' + word + '" 的音标和 1~3 条最常用中文释义。"plainEnglish" 请用一句简单易懂的英文解释该单词的意思（适合英语学习者）。严格按此格式输出：' +
        '{"phonetic":"<IPA音标>","definitions":[{"pos":"<词性缩写，如 n./v./adj./adv.>","meaning":"<中文释义>"}],"memoryTip":"<一句话快速记忆方法>","plainEnglish":"<一句简单易懂的英文释义>"}';
```

`parseLookupResponse` 在 `memoryTip` 块之后追加：

```js
    const plainEnglish =
      typeof data.plainEnglish === "string" && data.plainEnglish.trim() !== ""
        ? data.plainEnglish.trim()
        : null;
```

并在 `return` 的 `data` 对象中 `memoryTip: memoryTip,` 之后追加：

```js
        plainEnglish: plainEnglish,
```

同时更新函数头注释的 `data` 形状描述，追加 `plainEnglish`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test`
Expected: PASS，全部测试通过（28 个）。

- [ ] **Step 5: 提交**

```bash
git add lib/lookup.js tests/lookup.test.js
git commit -m "feat: add plainEnglish field to lookup prompt and parser"
```

---

### Task 2: 弹窗渲染「英文释义」行

**Files:**
- Modify: `content.js` — `renderResult`

**Interfaces:**
- Consumes: Task 1 的 `result.data.plainEnglish: string|null`。
- Produces: 「记忆」行下方追加 `.context` 样式块，标签「英文释义」。

- [ ] **Step 1: 实现渲染**

在 `renderResult` 中 `if (result.data.memoryTip) { ... }` 块结束（`}`）之后、`} else {` 之前插入：

```js
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
```

- [ ] **Step 2: 语法检查**

Run: `node --check content.js`
Expected: 无输出。

- [ ] **Step 3: 提交**

```bash
git add content.js
git commit -m "feat: render plain English explanation row"
```

---

### Task 3: E2E 证据更新

**Files:**
- Modify: `e2e/e2e-happy.png`

**Interfaces:**
- Consumes: Task 2 的渲染结果；`e2e/serve.js`（127.0.0.1:8123）；Chrome/Chromium + CDP `Extensions.loadUnpacked`。

- [ ] **Step 1: 启动测试服务器**

Run: `node e2e/serve.js`
Expected: 输出 `test server ready: http://127.0.0.1:8123/test-page.html`。

- [ ] **Step 2: 加载扩展并拦截 API**

用 CDP `Extensions.loadUnpacked` 加载仓库（注意：若扩展已被同一浏览器实例加载过且状态异常，加载一份仓库副本到临时目录以获得新扩展 ID）。在 service worker 目标上启用 `Fetch` 拦截 `https://api.deepseek.com/*`，返回含 `plainEnglish` 的伪造 JSON；在 SW 上下文执行 `chrome.storage.local.set({apiKey:"sk-e2e"})`。注意：旧会话持久化的 `lookupCache_v1` 可能命中缓存而不发请求——换一个词（不同缓存键）即可绕过。

- [ ] **Step 3: 双击取词并截图**

双击 `serendipity`（或缓存未命中的其他词）；确认弹窗出现音标、释义、语境义、记忆与「英文释义」三行；`Page.captureScreenshot`（format: png）保存为 `e2e/e2e-happy.png`。
Expected: Shadow DOM 中 `.context` 块恰为 3 个，最后一个以「英文释义」开头。

- [ ] **Step 4: 提交**

```bash
git add e2e/e2e-happy.png
git commit -m "test: update e2e screenshot with plain english row"
```

---

### Task 4: 设计文档修订记录

**Files:**
- Modify: `docs/superpowers/specs/2026-08-20-deepseek-word-translator-design.md`

- [ ] **Step 1: 追加修订条目**（第 11 节修订记录末尾，第 6 条）

```markdown
6. **英文释义行**：提示词 JSON 增加可选字段 `plainEnglish`（一句简单易懂的英文解释该单词的意思，适合英语学习者）；解析规则与 `contextMeaning`/`memoryTip` 一致（缺失/空白/非字符串 → `null`）；弹窗在「记忆」行下方新增「英文释义」行，字段为 `null` 时不渲染该行；缓存键不变，旧缓存条目无该字段即隐藏此行，无需迁移。
```

- [ ] **Step 2: 提交**

```bash
git add docs/superpowers/specs/2026-08-20-deepseek-word-translator-design.md
git commit -m "docs: record plain english revision in design spec"
```
