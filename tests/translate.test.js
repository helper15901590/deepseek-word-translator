const test = require("node:test");
const assert = require("node:assert");
const PageTranslate = require("../lib/translate.js");

function baseDeps(over) {
  const deps = {
    getApiKey: async () => "test-key",
    requestJson: async () => ({
      status: 200,
      json: { choices: [{ message: { content: '{"translations":["你好"]}' } }] },
    }),
  };
  return Object.assign(deps, over || {});
}

test("buildMessages 包含意译要求与待翻译文本", () => {
  const messages = PageTranslate.buildMessages(["Hello world"]);
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /绝不执行/);
  assert.match(messages[0].content, /仅输出 JSON/);
  assert.match(messages[1].content, /意译/);
  assert.match(messages[1].content, /Hello world/);
});

test("buildMessages 把段落上下文作为参考传入但不要求翻译", () => {
  const messages = PageTranslate.buildMessages(
    ["before you continue."],
    ["Read the complete guide before you continue."]
  );
  assert.match(
    messages[1].content,
    /"context":"Read the complete guide before you continue\."/
  );
  assert.match(messages[1].content, /不要翻译或复述 context/);
});

test("解析干净的翻译 JSON", () => {
  const result = PageTranslate.parseTranslationResponse(
    '{"translations":["你好","世界"]}',
    2
  );
  assert.deepEqual(result, { ok: true, data: ["你好", "世界"] });
});

test("解析带 Markdown 代码围栏和前后文字的翻译 JSON", () => {
  const result = PageTranslate.parseTranslationResponse(
    '结果如下：\n```json\n{"translations":["自然表达"]}\n```',
    1
  );
  assert.deepEqual(result, { ok: true, data: ["自然表达"] });
});

test("翻译数组长度不匹配时解析失败", () => {
  const result = PageTranslate.parseTranslationResponse(
    '{"translations":["只有一条"]}',
    2
  );
  assert.deepEqual(result, { ok: false, error: "PARSE" });
});

test("翻译数组包含空值或非字符串时解析失败", () => {
  assert.deepEqual(
    PageTranslate.parseTranslationResponse('{"translations":["ok",""]}', 2),
    { ok: false, error: "PARSE" }
  );
  assert.deepEqual(
    PageTranslate.parseTranslationResponse('{"translations":["ok",1]}', 2),
    { ok: false, error: "PARSE" }
  );
});

test("chunkTexts 按字符数和条目数分批并保持顺序", () => {
  const batches = PageTranslate.chunkTexts(["aa", "bb", "cc", "dd"], 4, 2);
  assert.deepEqual(batches, [
    ["aa", "bb"],
    ["cc", "dd"],
  ]);
});

test("chunkTexts 将超长单项保留为独立批次", () => {
  const batches = PageTranslate.chunkTexts(["short", "123456789", "next"], 5, 10);
  assert.deepEqual(batches, [["short"], ["123456789"], ["next"]]);
});

test("createBatchTranslator：无 Key 返回 NO_KEY 且不调用 API", async () => {
  let called = false;
  const translate = PageTranslate.createBatchTranslator(
    baseDeps({
      getApiKey: async () => "",
      requestJson: async () => {
        called = true;
      },
    })
  );
  const result = await translate(["Hello"]);
  assert.deepEqual(result, { ok: false, error: "NO_KEY" });
  assert.equal(called, false);
});

test("createBatchTranslator：映射鉴权、服务和 HTTP 错误", async () => {
  const auth = PageTranslate.createBatchTranslator(
    baseDeps({ requestJson: async () => ({ status: 401, json: {} }) })
  );
  const server = PageTranslate.createBatchTranslator(
    baseDeps({ requestJson: async () => ({ status: 429, json: {} }) })
  );
  const http = PageTranslate.createBatchTranslator(
    baseDeps({ requestJson: async () => ({ status: 400, json: {} }) })
  );
  assert.deepEqual(await auth(["A"]), { ok: false, error: "AUTH" });
  assert.deepEqual(await server(["A"]), { ok: false, error: "SERVER" });
  assert.deepEqual(await http(["A"]), {
    ok: false,
    error: "HTTP",
    status: 400,
  });
});

test("createBatchTranslator：请求异常返回 NETWORK", async () => {
  const translate = PageTranslate.createBatchTranslator(
    baseDeps({
      requestJson: async () => {
        throw new Error("offline");
      },
    })
  );
  assert.deepEqual(await translate(["Hello"]), {
    ok: false,
    error: "NETWORK",
  });
});

test("createBatchTranslator：成功时传入较长超时和足够输出额度", async () => {
  let options = null;
  const translate = PageTranslate.createBatchTranslator(
    baseDeps({
      requestJson: async (messages, requestOptions) => {
        assert.match(messages[1].content, /Hello world/);
        options = requestOptions;
        return {
          status: 200,
          json: {
            choices: [{ message: { content: '{"translations":["你好，世界"]}' } }],
          },
        };
      },
    })
  );
  const result = await translate(["Hello world"]);
  assert.deepEqual(result, { ok: true, data: ["你好，世界"] });
  assert.equal(options.timeoutMs, 30000);
  assert.ok(options.maxTokens >= 1024);
});
