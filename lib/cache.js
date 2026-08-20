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
