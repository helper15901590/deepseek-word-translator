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
