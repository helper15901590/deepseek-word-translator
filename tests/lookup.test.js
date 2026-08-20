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
