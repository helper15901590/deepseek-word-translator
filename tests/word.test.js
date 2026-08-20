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
