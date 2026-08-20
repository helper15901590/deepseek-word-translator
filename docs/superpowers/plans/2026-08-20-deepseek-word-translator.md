# DeepSeek 单词翻译插件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个 Chrome MV3 扩展：双击网页英文单词，在词旁弹窗显示音标与 1~3 条中文释义（含词性），释义由 DeepSeek API 生成。

**Architecture:** content script 捕获双击并取词 → `chrome.runtime.sendMessage` → 后台 Service Worker 查 LRU 缓存（未命中则调 `deepseek-chat`）→ 返回 JSON → content script 用 Shadow DOM 弹窗渲染。API Key 经 popup 面板存入 `chrome.storage.local`，仅 background 读取。零外部依赖，纯原生 JS（UMD 模式共享 lib）。

**Tech Stack:** Chrome Manifest V3、原生 JS（无构建、无依赖）、Node `node:test`（单元测试）、puppeteer/browser 工具 + CDP Fetch 拦截（E2E）。

## Global Constraints

- 零运行时/构建依赖：所有扩展代码为纯 ES5+ 原生 JS，无 npm 包、无打包器。
- 单元测试用 Node 内置 `node --test`，本机 Node v24.18.0。
- 共享 lib 文件用 UMD 模式（`module.exports` + `globalThis` 挂载），同一文件同时被 Node 测试、`importScripts`（background）、content script 按序加载三处使用。
- 消息协议（content ↔ background）：请求 `{type:'lookup', word:string}`；响应 `{ok:true, data:{word,phonetic,definitions:[{pos,meaning}]}}` 或 `{ok:false, error:'NO_KEY'|'AUTH'|'SERVER'|'NETWORK'|'HTTP'|'PARSE'|'INVALID'}`（`HTTP` 附带 `status`）。
- `chrome.storage.local` 键：`apiKey`（string）、`lookupCache_v1`（`[word, data][]`）。
- API：`POST https://api.deepseek.com/chat/completions`，模型 `deepseek-chat`，`temperature: 0.3`，`max_tokens: 200`，`stream: false`。
- 单词校验正则 `^[A-Za-z][A-Za-z'-]*$`，长度 1~50。
- 缓存容量 500 条，LRU。
- API Key 不打日志、不写入代码、不写入弹窗内容。
- 所有 DOM 文本用 `textContent` 渲染，禁止 `innerHTML`。
- 弹窗 Shadow DOM mode 用 `"open"`（供 E2E 断言读取，弹窗内容无秘密）。
- 项目根：`deepseek-word-translator/`，所有路径相对此目录。
- 提交信息格式：`feat:` / `test:` / `docs:` 前缀。

## 文件结构

```
deepseek-word-translator/
├── manifest.json          # MV3 清单：权限、SW、content script、popup
├── background.js          # Service Worker：消息处理、缓存恢复/持久化、真实 fetch
├── content.js             # 双击捕获、取词、Shadow DOM 弹窗渲染/关闭
├── popup.html             # 面板 UI（含内联样式）
├── popup.js               # Key 的读取/保存/清除
├── lib/
│   ├── word.js            # 单词校验（content 与 background 共用）
│   ├── lookup.js          # 提示词构建、响应解析、lookup 流程（依赖注入）
│   └── cache.js           # LRUCache
├── tests/
│   ├── word.test.js
│   ├── lookup.test.js
│   └── cache.test.js
└── test/
    ├── test-page.html     # E2E 测试页（英文段落 + 中文段落）
    └── serve.js           # 本地静态服务器（127.0.0.1:8123）
```

---

### Task 1: 项目骨架 + 单词校验模块

**Files:**
- Create: `manifest.json`
- Create: `lib/word.js`
- Create: `tests/word.test.js`

**Interfaces:**
- Produces: `globalThis.WordUtils = { isValidWord(word): boolean, normalizeWord(word): string, MAX_LEN: 50 }`（UMD：Node 下亦 `module.exports`）

- [ ] **Step 1: 写失败测试**

创建 `tests/word.test.js`：

```js
const { test } = require("node:test");
const assert = require("node:assert");
const { isValidWord, normalizeWord } = require("../lib/word.js");

test("接受常见英文单词", () => {
  assert.equal(isValidWord("hello"), true);
  assert.equal(isValidWord("OpenAI"), true);
  assert.equal(isValidWord("don't"), true);
  assert.equal(isValidWord("O'Reilly"), true);
  assert.equal(isValidWord("state-of-the-art"), true);
  assert.equal(isValidWord("  padded  "), true);
});

test("拒绝非单词", () => {
  assert.equal(isValidWord(""), false);
  assert.equal(isValidWord("hello world"), false);
  assert.equal(isValidWord("123"), false);
  assert.equal(isValidWord("你好"), false);
  assert.equal(isValidWord("a".repeat(51)), false);
  assert.equal(isValidWord(null), false);
  assert.equal(isValidWord(undefined), false);
});

test("normalizeWord 转小写并去空白", () => {
  assert.equal(normalizeWord("  Hello "), "hello");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/`
Expected: FAIL，`Cannot find module '../lib/word.js'`

- [ ] **Step 3: 实现 `lib/word.js`**

```js
// 单词校验与规范化（content script / background / Node 测试共用）
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.WordUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const WORD_RE = /^[A-Za-z][A-Za-z'-]*$/;
  const MAX_LEN = 50;

  function isValidWord(word) {
    if (typeof word !== "string") return false;
    const w = word.trim();
    return w.length > 0 && w.length <= MAX_LEN && WORD_RE.test(w);
  }

  function normalizeWord(word) {
    return word.trim().toLowerCase();
  }

  return { isValidWord, normalizeWord, MAX_LEN };
});
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/`
Expected: PASS（3 个测试）

- [ ] **Step 5: 创建 `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "DeepSeek 单词翻译",
  "version": "1.0.0",
  "description": "双击英文单词，显示音标与中文释义（由 DeepSeek 驱动）",
  "permissions": ["storage"],
  "host_permissions": ["https://api.deepseek.com/*"],
  "background": { "service_worker": "background.js" },
  "action": {
    "default_title": "DeepSeek 单词翻译",
    "default_popup": "popup.html"
  },
  "content_scripts": [
    {
      "matches": ["http://*/*", "https://*/*"],
      "js": ["lib/word.js", "content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

（此任务先写 `storage` 权限与 content script 声明；`background.js`、`popup.html` 在后续任务创建。）

- [ ] **Step 6: 校验 manifest JSON 合法**

Run: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest OK')"`
Expected: `manifest OK`

- [ ] **Step 7: 提交**

```bash
git add manifest.json lib/word.js tests/word.test.js
git commit -m "feat: add manifest and word validation module"
```

---

### Task 2: 提示词构建 + 响应解析 + lookup 流程

**Files:**
- Create: `lib/lookup.js`
- Create: `tests/lookup.test.js`

**Interfaces:**
- Consumes: 无（纯函数 + 依赖注入）
- Produces: `globalThis.Lookup = { SYSTEM_PROMPT, buildMessages(word): [{role,content}], parseLookupResponse(text, word): {ok,data|error}, createLookup(deps): async lookup(word) }`
  - `deps = { getApiKey(): Promise<string>, requestJson(messages): Promise<{status:number, json:object|null}>, cache: {get(word), set(word,data)} }`
  - `lookup(word)` 返回 `{ok:true, data}` 或 `{ok:false, error}`（`HTTP` 带 `status`）
  - 错误码：`INVALID`（非法输入）、`NO_KEY`、`AUTH`（401）、`SERVER`（429/5xx）、`NETWORK`（请求抛异常）、`HTTP`（其他状态/无 json）、`PARSE`（模型输出不可解析）

- [ ] **Step 1: 写失败测试**

创建 `tests/lookup.test.js`：

```js
const { test } = require("node:test");
const assert = require("node:assert");
const {
  buildMessages,
  parseLookupResponse,
  createLookup,
} = require("../lib/lookup.js");

const GOOD =
  '{"phonetic":"/test/","definitions":[{"pos":"n.","meaning":"测试"},{"pos":"v.","meaning":"检验"}]}';

test("buildMessages 生成 system+user 两条消息且包含单词", () => {
  const msgs = buildMessages("serendipity");
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[1].role, "user");
  assert.ok(msgs[1].content.includes("serendipity"));
});

test("解析干净 JSON", () => {
  const r = parseLookupResponse(GOOD, "test");
  assert.equal(r.ok, true);
  assert.equal(r.data.word, "test");
  assert.equal(r.data.phonetic, "/test/");
  assert.deepEqual(r.data.definitions, [
    { pos: "n.", meaning: "测试" },
    { pos: "v.", meaning: "检验" },
  ]);
});

test("解析带 markdown 代码围栏的 JSON", () => {
  const r = parseLookupResponse("```json\n" + GOOD + "\n```", "test");
  assert.equal(r.ok, true);
});

test("解析夹杂前后文字的 JSON", () => {
  const r = parseLookupResponse("结果如下：\n" + GOOD + "\n希望有帮助。", "test");
  assert.equal(r.ok, true);
});

test("释义超过 3 条时截断", () => {
  const four =
    '{"phonetic":"/t/","definitions":[{"pos":"n.","meaning":"一"},{"pos":"v.","meaning":"二"},{"pos":"adj.","meaning":"三"},{"pos":"adv.","meaning":"四"}]}';
  const r = parseLookupResponse(four, "t");
  assert.equal(r.ok, true);
  assert.equal(r.data.definitions.length, 3);
});

test("跳过无效释义条目", () => {
  const mixed =
    '{"phonetic":"/t/","definitions":[{"pos":"n.","meaning":"一"},{"pos":5,"meaning":"坏"}]}';
  const r = parseLookupResponse(mixed, "t");
  assert.equal(r.ok, true);
  assert.equal(r.data.definitions.length, 1);
});

test("结构不完整时解析失败", () => {
  assert.equal(parseLookupResponse('{"definitions":[]}', "t").ok, false);
  assert.equal(parseLookupResponse('{"phonetic":"/t/"}', "t").ok, false);
  assert.equal(
    parseLookupResponse('{"phonetic":"/t/","definitions":[{"pos":"n.","meaning":""}]}', "t").ok,
    false
  );
  assert.equal(parseLookupResponse("完全不是 JSON", "t").ok, false);
  assert.equal(parseLookupResponse("", "t").ok, false);
  assert.equal(parseLookupResponse(null, "t").ok, false);
});

test("createLookup：无 Key 返回 NO_KEY 且不调用 API", async () => {
  let called = false;
  const lookup = createLookup({
    getApiKey: async () => "",
    requestJson: async () => { called = true; },
    cache: { get: () => undefined, set: () => {} },
  });
  const r = await lookup("test");
  assert.equal(r.ok, false);
  assert.equal(r.error, "NO_KEY");
  assert.equal(called, false);
});

test("createLookup：缓存命中不调用 API", async () => {
  let called = false;
  const cached = { word: "test", phonetic: "/test/", definitions: [{ pos: "n.", meaning: "测试" }] };
  const lookup = createLookup({
    getApiKey: async () => "sk-x",
    requestJson: async () => { called = true; },
    cache: { get: () => cached, set: () => {} },
  });
  const r = await lookup("test");
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, cached);
  assert.equal(called, false);
});

test("createLookup：401→AUTH，429/500→SERVER，400→HTTP", async () => {
  const mk = (status) =>
    createLookup({
      getApiKey: async () => "sk-x",
      requestJson: async () => ({ status, json: null }),
      cache: { get: () => undefined, set: () => {} },
    });
  assert.equal((await mk(401)("t")).error, "AUTH");
  assert.equal((await mk(429)("t")).error, "SERVER");
  assert.equal((await mk(500)("t")).error, "SERVER");
  const httpErr = await mk(400)("t");
  assert.equal(httpErr.error, "HTTP");
  assert.equal(httpErr.status, 400);
});

test("createLookup：请求抛异常 → NETWORK", async () => {
  const lookup = createLookup({
    getApiKey: async () => "sk-x",
    requestJson: async () => { throw new Error("fetch failed"); },
    cache: { get: () => undefined, set: () => {} },
  });
  assert.equal((await lookup("t")).error, "NETWORK");
});

test("createLookup：成功结果写入缓存并返回", async () => {
  let stored = null;
  const okResp = { status: 200, json: { choices: [{ message: { content: GOOD } }] } };
  const lookup = createLookup({
    getApiKey: async () => "sk-x",
    requestJson: async () => okResp,
    cache: { get: () => undefined, set: (w, d) => { stored = d; } },
  });
  const r = await lookup("test");
  assert.equal(r.ok, true);
  assert.deepEqual(stored, r.data);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/`
Expected: FAIL，`Cannot find module '../lib/lookup.js'`（word 测试仍 PASS）

- [ ] **Step 3: 实现 `lib/lookup.js`**

```js
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
    stripCodeFences,
    extractJsonObject,
    parseLookupResponse,
    createLookup,
  };
});
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/`
Expected: PASS（全部，word 3 个 + lookup 12 个）

- [ ] **Step 5: 提交**

```bash
git add lib/lookup.js tests/lookup.test.js
git commit -m "feat: add prompt building, response parsing and lookup flow"
```

---

### Task 3: LRU 缓存

**Files:**
- Create: `lib/cache.js`
- Create: `tests/cache.test.js`

**Interfaces:**
- Produces: `globalThis.Cache = { LRUCache }`；`new LRUCache(capacity=500)`；方法 `get(key) → value|undefined`（刷新热度）、`set(key,value)`（超容淘汰最久未用）、`has(key)`、`entries() → [[key,value],...]`（最旧→最新）；capacity 非正整数时构造抛 `Error`

- [ ] **Step 1: 写失败测试**

创建 `tests/cache.test.js`：

```js
const { test } = require("node:test");
const assert = require("node:assert");
const { LRUCache } = require("../lib/cache.js");

test("set/get/has 基本行为", () => {
  const c = new LRUCache(2);
  assert.equal(c.get("a"), undefined);
  c.set("a", 1);
  assert.equal(c.has("a"), true);
  assert.equal(c.get("a"), 1);
});

test("超过容量淘汰最久未使用", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  assert.equal(c.has("a"), false);
  assert.equal(c.has("b"), true);
  assert.equal(c.has("c"), true);
});

test("get 刷新热度", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  c.get("a");
  c.set("c", 3);
  assert.equal(c.has("a"), true);
  assert.equal(c.has("b"), false);
});

test("entries 返回最旧到最新顺序", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  assert.deepEqual(c.entries(), [["a", 1], ["b", 2]]);
});

test("非法容量抛错", () => {
  assert.throws(() => new LRUCache(0));
  assert.throws(() => new LRUCache(1.5));
  assert.throws(() => new LRUCache(-1));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/`
Expected: FAIL，`Cannot find module '../lib/cache.js'`

- [ ] **Step 3: 实现 `lib/cache.js`**

```js
// LRU 缓存（background / Node 测试共用）
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Cache = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  class LRUCache {
    constructor(capacity = 500) {
      if (!Number.isInteger(capacity) || capacity < 1) {
        throw new Error("capacity must be a positive integer");
      }
      this.capacity = capacity;
      this.map = new Map();
    }
    get(key) {
      if (!this.map.has(key)) return undefined;
      const value = this.map.get(key);
      this.map.delete(key);
      this.map.set(key, value);
      return value;
    }
    set(key, value) {
      if (this.map.has(key)) this.map.delete(key);
      this.map.set(key, value);
      if (this.map.size > this.capacity) {
        const oldest = this.map.keys().next().value;
        this.map.delete(oldest);
      }
    }
    has(key) {
      return this.map.has(key);
    }
    entries() {
      return Array.from(this.map.entries());
    }
  }
  return { LRUCache };
});
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/`
Expected: PASS（全部 20 个测试）

- [ ] **Step 5: 提交**

```bash
git add lib/cache.js tests/cache.test.js
git commit -m "feat: add LRU cache"
```

---

### Task 4: 后台 Service Worker

**Files:**
- Create: `background.js`

**Interfaces:**
- Consumes: `WordUtils`（`lib/word.js`）、`Cache.LRUCache`（`lib/cache.js`）、`Lookup.createLookup`（`lib/lookup.js`），经 `importScripts("lib/word.js","lib/cache.js","lib/lookup.js")` 加载。
- Produces: `chrome.runtime.onMessage` 处理器，响应协议见 Global Constraints；成功命中后异步持久化缓存到 `storage.local` 的 `lookupCache_v1`；SW 启动时从 `lookupCache_v1` 恢复缓存。

- [ ] **Step 1: 实现 `background.js`**

```js
// Service Worker：取词查询代理 + 缓存 + DeepSeek 调用
importScripts("lib/word.js", "lib/cache.js", "lib/lookup.js");

const API_URL = "https://api.deepseek.com/chat/completions";
const CACHE_STORAGE_KEY = "lookupCache_v1";
const API_KEY_STORAGE_KEY = "apiKey";
const CACHE_CAPACITY = 500;
const TIMEOUT_MS = 15000;

const cache = new Cache.LRUCache(CACHE_CAPACITY);

// 启动时恢复持久化缓存
chrome.storage.local.get(CACHE_STORAGE_KEY).then((items) => {
  const arr = items[CACHE_STORAGE_KEY];
  if (Array.isArray(arr)) {
    for (const entry of arr) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && entry[1]) {
        cache.set(entry[0], entry[1]);
      }
    }
  }
});

function persistCache() {
  return chrome.storage.local
    .set({ [CACHE_STORAGE_KEY]: cache.entries() })
    .catch(() => {});
}

async function getApiKey() {
  const items = await chrome.storage.local.get(API_KEY_STORAGE_KEY);
  const key = items[API_KEY_STORAGE_KEY];
  return typeof key === "string" ? key.trim() : "";
}

async function requestJson(messages) {
  const apiKey = await getApiKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: messages,
        temperature: 0.3,
        max_tokens: 200,
        stream: false,
      }),
      signal: controller.signal,
    });
    let json = null;
    try {
      json = await response.json();
    } catch (e) {
      json = null;
    }
    return { status: response.status, json: json };
  } finally {
    clearTimeout(timer);
  }
}

const lookup = Lookup.createLookup({
  getApiKey: getApiKey,
  requestJson: requestJson,
  cache: {
    get: (word) => cache.get(word),
    set: (word, data) => {
      cache.set(word, data);
      persistCache();
    },
  },
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "lookup") return;
  (async () => {
    if (!WordUtils.isValidWord(message.word)) {
      sendResponse({ ok: false, error: "INVALID" });
      return;
    }
    const word = WordUtils.normalizeWord(message.word);
    sendResponse(await lookup(word));
  })();
  return true; // 异步 sendResponse
});
```

- [ ] **Step 2: 语法检查**

Run: `node --check background.js`
Expected: 无输出（通过）；注意 `importScripts`/`chrome` 为 SW 运行时全局，`--check` 只查语法不执行。

- [ ] **Step 3: 提交**

```bash
git add background.js
git commit -m "feat: add background service worker with caching"
```

---

### Task 5: Content Script + 弹窗

**Files:**
- Create: `content.js`
- Create: `test/test-page.html`

**Interfaces:**
- Consumes: `WordUtils`（manifest 已声明按序加载 `lib/word.js` 先行）；消息协议（见 Global Constraints）。
- Produces: 页面内行为——双击英文单词 → 弹窗（`<div id="dswt-popup-host">`，Shadow DOM `mode:"open"`）；Esc/点击外部/滚动/窗口 resize 关闭；同一时刻仅一个弹窗；错误码 → 中文提示文案（`NO_KEY`→「请点击浏览器工具栏插件图标，填入 DeepSeek API Key」；`AUTH`→「API Key 无效或已过期，请在插件面板中更新」；`SERVER`→「DeepSeek 服务暂时不可用，请稍后再试」；`NETWORK`→「网络请求失败，请检查网络连接」；`HTTP`→「请求失败（HTTP <status>）」；`PARSE`→「释义解析失败，请重试」）。

- [ ] **Step 1: 实现 `content.js`**

```js
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
```

- [ ] **Step 2: 语法检查**

Run: `node --check content.js`
Expected: 无输出（通过）

- [ ] **Step 3: 创建 E2E 测试页 `test/test-page.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>DeepSeek 单词翻译 - E2E 测试页</title>
<style>
  body { font: 16px/1.8 Georgia, "Microsoft YaHei", serif; max-width: 640px; margin: 40px auto; padding: 0 20px; }
</style>
</head>
<body>
<h1>Test Page</h1>
<p>
  The word serendipity describes a fortunate discovery by chance.
  Technology has become ubiquitous in modern life, and a meticulous
  engineer reviews every detail before shipping.
</p>
<p>
  这是一段中文文本，双击这里的词语不应弹出释义，因为插件仅处理英文单词。
</p>
</body>
</html>
```

- [ ] **Step 4: 提交**

```bash
git add content.js test/test-page.html
git commit -m "feat: add content script with shadow DOM popup"
```

---

### Task 6: Popup 面板（API Key 配置）

**Files:**
- Create: `popup.html`
- Create: `popup.js`

**Interfaces:**
- Produces: 工具栏图标弹窗——读取 `storage.local.apiKey` 回填、保存、清除；状态提示「已保存」/「已清除」/「请输入 API Key」。

- [ ] **Step 1: 实现 `popup.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>DeepSeek 单词翻译</title>
<style>
  body { width: 300px; margin: 0; padding: 12px; font: 13px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 14px; margin: 0 0 10px; }
  label { display: block; margin-bottom: 4px; color: #57606a; }
  input { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid #d0d7de; border-radius: 6px; }
  .row { margin-top: 8px; display: flex; gap: 8px; }
  button { flex: 1; padding: 6px 12px; border: 1px solid #d0d7de; border-radius: 6px; background: #f6f8fa; cursor: pointer; }
  #save { background: #0969da; color: #fff; border-color: #0969da; }
  #status { margin-top: 8px; min-height: 1.2em; color: #2da44e; }
  #status.error { color: #d1242f; }
</style>
</head>
<body>
<h1>DeepSeek 单词翻译</h1>
<label for="key">API Key</label>
<input type="password" id="key" placeholder="sk-...">
<div class="row">
  <button id="save">保存</button>
  <button id="clear">清除</button>
</div>
<div id="status"></div>
<script src="popup.js"></script>
</body>
</html>
```

- [ ] **Step 2: 实现 `popup.js`**

```js
const keyInput = document.getElementById("key");
const statusEl = document.getElementById("status");

function showStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", !!isError);
}

chrome.storage.local.get("apiKey").then((items) => {
  if (typeof items.apiKey === "string") keyInput.value = items.apiKey;
});

document.getElementById("save").addEventListener("click", () => {
  const key = keyInput.value.trim();
  if (!key) {
    showStatus("请输入 API Key", true);
    return;
  }
  chrome.storage.local.set({ apiKey: key }).then(() => showStatus("已保存", false));
});

document.getElementById("clear").addEventListener("click", () => {
  chrome.storage.local.remove("apiKey").then(() => {
    keyInput.value = "";
    showStatus("已清除", false);
  });
});
```

- [ ] **Step 3: 语法检查**

Run: `node --check popup.js`
Expected: 无输出（通过）

- [ ] **Step 4: 提交**

```bash
git add popup.html popup.js
git commit -m "feat: add popup panel for API key management"
```

---

### Task 7: 端到端验证（自动化 Chrome + CDP 拦截 DeepSeek 请求）

**Files:**
- Create: `test/serve.js`

**Interfaces:**
- Consumes: Task 1~6 全部产物。
- Produces: 全链路验证证据（截图 + 断言输出），覆盖：正常释义、无 Key、401、500、网络失败、缓存命中不重复请求、中文不触发。

**背景知识：**
- 用 browser 工具以 `app.path` 启动本机 Chrome（`C:/Program Files/Google/Chrome/Application/chrome.exe`），`app.args` 加 `--disable-extensions-except=<项目绝对路径>` 与 `--load-extension=<项目绝对路径>`。
- MV3 Service Worker 是独立 target（`type() === "service_worker"`），页面级 request 拦截看不到 SW 的 fetch；必须对 SW target 建 CDP session 用 `Fetch` 域拦截并 `Fetch.fulfillRequest`/`Fetch.failRequest` 造假响应。
- SW 空闲会休眠，需先从 popup 页发消息唤醒再 attach（扩展页签可直接用 `chrome.runtime.sendMessage`）。
- 弹窗 Shadow DOM mode 为 `open`，页面 `evaluate` 可直接读 `document.getElementById("dswt-popup-host").shadowRoot.textContent` 断言。
- browser 工具的 run 域拦截/处理器是 run-scoped，每个场景用一个独立 run。
- 每个 run 内 `wait(fn)` 轮询可用；双击用 `page.mouse.click(x, y, { clickCount: 2 })`。

- [ ] **Step 1: 创建本地服务器 `test/serve.js`**

```js
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
http
  .createServer((req, res) => {
    const name = req.url === "/" ? "test-page.html" : req.url.split("?")[0];
    const file = path.join(root, "test", name);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, {
        "Content-Type": name.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain",
      });
      res.end(data);
    });
  })
  .listen(8123, "127.0.0.1", () => {
    console.log("test server ready: http://127.0.0.1:8123/test-page.html");
  });
```

- [ ] **Step 2: 启动服务器（hub 托管进程）**

用 `hub` op `"start"`，`application: "node"`，`args: ["test/serve.js"]`，`cwd: <项目根>`，`ready: {port: 8123, timeout: 10}`。
Expected: ready。

- [ ] **Step 3: 场景 0 —— 启动 Chrome（带扩展）**

browser 工具 `open`：`app: { path: "C:/Program Files/Google/Chrome/Application/chrome.exe", args: ["--disable-extensions-except=C:/Users/Administrator/Desktop/outputs/deepseek-word-translator", "--load-extension=C:/Users/Administrator/Desktop/outputs/deepseek-word-translator", "--no-first-run", "--no-default-browser-check"] }`，tab name `e2e`。
然后 `run` 打开测试页：`await tab.goto("http://127.0.0.1:8123/test-page.html")`。
通过 `chrome://extensions` 确认扩展加载成功并获取扩展 ID：打开 `chrome://extensions`，evaluate 从 `chrome.developerPrivate` 不可用时退化为：`browser.targets()` 里找 `type()==="service_worker"` 且 URL 含 `background.js` 的 target，其 URL `chrome-extension://<id>/background.js` 中的 host 即扩展 ID。若 SW 尚未出现（未醒），先执行场景 1 的唤醒步骤再查。

注意：puppeteer 默认参数含 `--disable-extensions`，可能压制 `--load-extension`。若 `browser.targets()` 中始终无扩展 SW target，改用回退方案：`hub` op `"start"` 直接启动 `"C:/Program Files/Google/Chrome/Application/chrome.exe"`，args 为 `["--remote-debugging-port=9222", "--user-data-dir=<项目根>/../.chrome-e2e-profile", "--disable-extensions-except=<项目绝对路径>", "--load-extension=<项目绝对路径>", "--no-first-run", "--no-default-browser-check"]`，`ready: {port: 9222}`；再以 `app: { cdp_url: "http://127.0.0.1:9222" }` 连接。两条路径二选一，选能加载扩展的那条。

- [ ] **Step 4: 场景 1 —— 保存 API Key（popup 页签）**

在 run 中：
```js
const extId = <Step 3 得到的扩展 ID>;
await tab.goto("chrome-extension://" + extId + "/popup.html");
await tab.fill("#key", "sk-test-mock");
await tab.click("#save");
// 断言状态
assert((await tab.evaluate(() => document.getElementById("status").textContent)) === "已保存");
// 顺带唤醒 SW：扩展页可直接发消息
await tab.evaluate(() => chrome.runtime.sendMessage({ type: "ping" }).catch(() => {}));
```
Expected: 状态显示「已保存」。

- [ ] **Step 5: 场景 2 —— 正常释义（拦截 API 返回固定 JSON）**

run 代码骨架（每个错误场景复用，仅替换 fulfill 参数）：
```js
// 1. 找到 SW target 并 attach CDP
const swTarget = await wait(() => {
  const t = browser.targets().find((t) => t.type() === "service_worker" && t.url().includes("background.js"));
  return t || false;
});
const sw = await swTarget.createCDPSession();
await sw.send("Fetch.enable", {
  patterns: [{ urlPattern: "*api.deepseek.com/*" }],
});
let apiHits = 0;
const MOCK = JSON.stringify({
  choices: [{ message: { content: '{"phonetic":"/ˌsɛrənˈdɪpəti/","definitions":[{"pos":"n.","meaning":"机缘巧合；意外发现珍宝的运气"}]}' } }],
});
sw.on("Fetch.requestPaused", async (ev) => {
  apiHits++;
  await sw.send("Fetch.fulfillRequest", {
    requestId: ev.requestId,
    responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "application/json" }],
    body: Buffer.from(MOCK).toString("base64"),
  });
});
// 2. 打开测试页，双击 "serendipity"
await tab.goto("http://127.0.0.1:8123/test-page.html");
const box = await tab.evaluate(() => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const n = walker.currentNode;
    const i = n.data.indexOf("serendipity");
    if (i !== -1) {
      const r = document.createRange();
      r.setStart(n, i); r.setEnd(n, i + "serendipity".length);
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }
  }
  return null;
});
assert(box, "未找到单词 serendipity");
await tab.evaluate(() => new Promise((r) => setTimeout(r, 300)));
// 双击
await page.mouse.click(box.x, box.y, { clickCount: 2 });
// 3. 等待弹窗出现且包含释义
const text = await wait(() => tab.evaluate(() => {
  const h = document.getElementById("dswt-popup-host");
  return h ? h.shadowRoot.textContent : false;
}));
assert(text.includes("serendipity"), "弹窗应包含原词");
assert(text.includes("/ˌsɛrənˈdɪpəti/"), "弹窗应包含音标");
assert(text.includes("机缘巧合"), "弹窗应包含中文释义");
assert(apiHits === 1, "应恰好调用一次 API");
await tab.screenshot({ fullPage: false });
```
Expected: 全部断言通过，截图可见弹窗（音标 + 释义）。

- [ ] **Step 6: 场景 3 —— 缓存：同一单词二次双击不再请求 API**

在场景 2 之后（同一 Chrome 实例内）再次 run：重新 attach SW target + Fetch.enable，然后对同一单词再双击，断言 `apiHits === 0` 且弹窗立即出现释义（来源于缓存）。注意 attach 后计数从 0 开始。
Expected: `apiHits === 0`，弹窗仍含「机缘巧合」。

- [ ] **Step 7: 场景 4 —— 无 Key → NO_KEY 文案**

run：先通过 popup 页签执行 `chrome.storage.local.remove("apiKey")`；attach Fetch（本场景不应有请求）；双击单词；断言弹窗文本包含「请点击浏览器工具栏插件图标」且 `apiHits === 0`。
Expected: 通过。结束后在 popup 页签恢复 Key（`chrome.storage.local.set({apiKey:"sk-test-mock"})`）。

- [ ] **Step 8: 场景 5 —— 401 → AUTH 文案**

run：attach Fetch，fulfill 时 `responseCode: 401`；双击单词；断言弹窗文本包含「API Key 无效或已过期」。
Expected: 通过。

- [ ] **Step 9: 场景 6 —— 500 → SERVER 文案；网络失败 → NETWORK 文案**

run A：fulfill `responseCode: 500` → 断言「服务暂时不可用」。
run B：`Fetch.failRequest(requestId, { errorReason: "Failed" })` → 断言「网络请求失败」。
Expected: 均通过。

- [ ] **Step 10: 场景 7 —— 中文文本双击不触发**

run：双击测试页第二段中文（如「词语」两字坐标）；断言 `document.getElementById("dswt-popup-host")` 为 null。
Expected: 无弹窗。

- [ ] **Step 11: 场景 8 —— 弹窗关闭行为**

run：双击英文单词出现弹窗后，`page.keyboard.press("Escape")` → 断言 host 为 null；再双击出现后点击页面空白处 → 断言 host 为 null。
Expected: 通过。

- [ ] **Step 12: 提交（含证据说明）**

```bash
git add test/serve.js
git commit -m "test: add e2e harness and verification notes"
```

（截图证据保存于会话 artifact，最终交付时引用。）

---

### Task 8: 最终走查与交付

**Files:**
- Modify: 无（除非走查发现问题）

- [ ] **Step 1: 全量单测回归**

Run: `node --test tests/`
Expected: PASS（20 个测试）

- [ ] **Step 2: 检查产物清单**

Run: `git ls-files`
Expected: `background.js`、`content.js`、`manifest.json`、`popup.html`、`popup.js`、`lib/*.js`（3 个）、`tests/*.test.js`（3 个）、`test/test-page.html`、`test/serve.js`、`docs/superpowers/specs/...`、`docs/superpowers/plans/...`

- [ ] **Step 3: 检查无敏感信息**

Run: `git grep -n -i "sk-" -- . 2>/dev/null || echo "no key found"`
Expected: `no key found`（测试用假 key `sk-test-mock` 仅在浏览器运行时注入 storage，不在仓库中——若 grep 命中 `sk-test-mock` 需确认为测试代码而非真实 key）

- [ ] **Step 4: 真实 API 冒烟（可选，需用户提供 key）**

用户在 popup 输入真实 Key 后，在任意网页双击一个英文单词，确认真实释义返回。若用户愿意在会话中提供 Key，则由我驱动 Chrome 执行一次真实查询验证。

- [ ] **Step 5: 提交收尾**

```bash
git add -A
git commit -m "chore: final cleanup" --allow-empty
```
（无变更则跳过提交）

- [ ] **Step 6: 交付说明（写入最终回复，不创建 README）**

给用户安装步骤：`chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选择 `deepseek-word-translator` 文件夹 → 点工具栏图标填 Key → 双击单词使用。以及错误提示含义对照表。

---

## 自检记录

- **Spec 覆盖**：翻译方向/触发方式/Key 配置/释义详细度（Task 2 提示词 + 截断逻辑）、缓存（Task 3/4）、错误处理（Task 2 错误码 + Task 5 文案 + Task 7 场景）、安全（Global Constraints + Task 8 Step 3）、验证方式（Task 7 全链路 + Task 8 单测回归）均有用例对应。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。
- **类型一致性**：`{ok, data|error}` 协议、`NO_KEY/AUTH/SERVER/NETWORK/HTTP/PARSE/INVALID` 错误码、`WordUtils/Lookup/Cache` 全局名、`apiKey`/`lookupCache_v1` 存储键在 Task 2/4/5/6/7 中一致；`HTTP` 附带 `status`（Task 2 测试与 Task 5 文案一致）。
