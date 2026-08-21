const { test } = require("node:test");
const assert = require("node:assert");
const {
  buildMessages,
  parseLookupResponse,
  createLookup,
  makeContextKey,
} = require("../lib/lookup.js");

const GOOD =
  '{"phonetic":"/test/","definitions":[{"pos":"n.","meaning":"测试"},{"pos":"v.","meaning":"检验"}]}';
const GOOD_CTX =
  '{"phonetic":"/test/","definitions":[{"pos":"n.","meaning":"测试"}],"contextMeaning":"此处指软件测试","memoryTip":"拆解 test 联想“测试”"}';
const CTX = "We ran a test on the new server.";

test("buildMessages 无语境：两条消息且不含语境说明", () => {
  const msgs = buildMessages("serendipity");
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[1].role, "user");
  assert.ok(msgs[1].content.includes("serendipity"));
  assert.ok(msgs[1].content.includes("memoryTip"));
  assert.ok(!msgs[1].content.includes("语境"));
});

test("buildMessages 有语境：user 消息包含语境文本与 contextMeaning 要求", () => {
  const msgs = buildMessages("test", CTX);
  assert.equal(msgs.length, 2);
  assert.ok(msgs[1].content.includes(CTX));
  assert.ok(msgs[1].content.includes("contextMeaning"));
  assert.ok(msgs[1].content.includes("memoryTip"));
  // 空白语境视为无语境
  const msgs2 = buildMessages("test", "   ");
  assert.ok(!msgs2[1].content.includes("contextMeaning"));
});

test("解析干净 JSON（无 contextMeaning → null）", () => {
  const r = parseLookupResponse(GOOD, "test");
  assert.equal(r.ok, true);
  assert.equal(r.data.word, "test");
  assert.equal(r.data.phonetic, "/test/");
  assert.equal(r.data.contextMeaning, null);
  assert.equal(r.data.memoryTip, null);
  assert.deepEqual(r.data.definitions, [
    { pos: "n.", meaning: "测试" },
    { pos: "v.", meaning: "检验" },
  ]);
});

test("解析含 contextMeaning 的 JSON", () => {
  const r = parseLookupResponse(GOOD_CTX, "test");
  assert.equal(r.ok, true);
  assert.equal(r.data.contextMeaning, "此处指软件测试");
  assert.equal(r.data.memoryTip, "拆解 test 联想“测试”");
});

test("contextMeaning 为空字符串/缺失时置 null", () => {
  const r1 = parseLookupResponse(
    '{"phonetic":"/t/","definitions":[{"pos":"n.","meaning":"一"}],"contextMeaning":""}',
    "t"
  );
  assert.equal(r1.ok, true);
  assert.equal(r1.data.contextMeaning, null);
  const r2 = parseLookupResponse(
    '{"phonetic":"/t/","definitions":[{"pos":"n.","meaning":"一"}],"contextMeaning":42}',
    "t"
  );
  assert.equal(r2.ok, true);
  assert.equal(r2.data.contextMeaning, null);
});

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

test("makeContextKey：无语境/空白 → 纯单词键", () => {
  assert.equal(makeContextKey("bank", null), "bank");
  assert.equal(makeContextKey("bank", undefined), "bank");
  assert.equal(makeContextKey("bank", "   "), "bank");
  assert.equal(makeContextKey("bank", ""), "bank");
});

test("makeContextKey：同语境同键、异语境异键、确定性", () => {
  const a1 = makeContextKey("bank", CTX);
  const a2 = makeContextKey("bank", CTX);
  const b = makeContextKey("bank", "He robbed the bank.");
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.ok(a1.startsWith("bank|"));
  assert.equal(makeContextKey("bank", CTX), a1);
});

const baseDeps = (over) => ({
  getApiKey: async () => "sk-x",
  requestJson: async () => { throw new Error("不应调用"); },
  cache: { get: () => undefined, set: () => {} },
  makeKey: makeContextKey,
  ...over,
});

test("createLookup：无 Key 返回 NO_KEY 且不调用 API", async () => {
  let called = false;
  const lookup = createLookup(baseDeps({
    getApiKey: async () => "",
    requestJson: async () => { called = true; },
  }));
  const r = await lookup("test");
  assert.equal(r.ok, false);
  assert.equal(r.error, "NO_KEY");
  assert.equal(called, false);
});

test("createLookup：缓存命中不调用 API（键经 makeKey 生成）", async () => {
  let called = false;
  let seenKey = null;
  const cached = { word: "test", phonetic: "/test/", definitions: [{ pos: "n.", meaning: "测试" }], contextMeaning: null };
  const lookup = createLookup(baseDeps({
    requestJson: async () => { called = true; },
    cache: { get: (k) => { seenKey = k; return cached; }, set: () => {} },
  }));
  const r = await lookup("test", CTX);
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, cached);
  assert.equal(called, false);
  assert.equal(seenKey, makeContextKey("test", CTX));
});

test("createLookup：401→AUTH，429/500→SERVER，400→HTTP", async () => {
  const mk = (status) =>
    createLookup(baseDeps({ requestJson: async () => ({ status, json: null }) }));
  assert.equal((await mk(401)("t")).error, "AUTH");
  assert.equal((await mk(429)("t")).error, "SERVER");
  assert.equal((await mk(500)("t")).error, "SERVER");
  const httpErr = await mk(400)("t");
  assert.equal(httpErr.error, "HTTP");
  assert.equal(httpErr.status, 400);
});

test("createLookup：请求抛异常 → NETWORK", async () => {
  const lookup = createLookup(baseDeps({
    requestJson: async () => { throw new Error("fetch failed"); },
  }));
  assert.equal((await lookup("t")).error, "NETWORK");
});

test("createLookup：成功结果写入缓存并返回（含语境义）", async () => {
  let storedKey = null;
  let storedData = null;
  let sentMessages = null;
  const okResp = { status: 200, json: { choices: [{ message: { content: GOOD_CTX } }] } };
  const lookup = createLookup(baseDeps({
    requestJson: async (msgs) => { sentMessages = msgs; return okResp; },
    cache: {
      get: () => undefined,
      set: (k, d) => { storedKey = k; storedData = d; },
    },
  }));
  const r = await lookup("test", CTX);
  assert.equal(r.ok, true);
  assert.equal(r.data.contextMeaning, "此处指软件测试");
  assert.equal(r.data.memoryTip, "拆解 test 联想“测试”");
  assert.equal(storedKey, makeContextKey("test", CTX));
  assert.deepEqual(storedData, r.data);
  assert.ok(sentMessages[1].content.includes(CTX));
});

test("createLookup：无语境时请求不含语境说明", async () => {
  let sentMessages = null;
  const okResp = { status: 200, json: { choices: [{ message: { content: GOOD } }] } };
  const lookup = createLookup(baseDeps({
    requestJson: async (msgs) => { sentMessages = msgs; return okResp; },
  }));
  const r = await lookup("test");
  assert.equal(r.ok, true);
  assert.ok(!sentMessages[1].content.includes("语境"));
});
