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
