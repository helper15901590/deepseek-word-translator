// Service Worker：取词 / 整页翻译查询代理 + 缓存 + DeepSeek 调用
importScripts(
  "lib/word.js",
  "lib/cache.js",
  "lib/lookup.js",
  "lib/translate.js"
);

const API_URL = "https://api.deepseek.com/chat/completions";
const CACHE_STORAGE_KEY = "lookupCache_v1";
const API_KEY_STORAGE_KEY = "apiKey";
const CACHE_CAPACITY = 500;
const TIMEOUT_MS = 15000;
const MAX_TRANSLATION_TEXTS = 32;
const MAX_TRANSLATION_CHARS = 5000;

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

async function requestJson(messages, options) {
  const opts = options || {};
  const requestedMaxTokens = Number.isInteger(opts.maxTokens)
    ? opts.maxTokens
    : 200;
  const maxTokens = Math.max(1, Math.min(8192, requestedMaxTokens));
  const requestedTimeout = Number.isInteger(opts.timeoutMs)
    ? opts.timeoutMs
    : TIMEOUT_MS;
  const timeoutMs = Math.max(1000, Math.min(60000, requestedTimeout));
  const apiKey = await getApiKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
        max_tokens: maxTokens,
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
  makeKey: Lookup.makeContextKey,
  cache: {
    get: (key) => cache.get(key),
    set: (key, data) => {
      cache.set(key, data);
      persistCache();
    },
  },
});

const translateBatch = PageTranslate.createBatchTranslator({
  getApiKey: getApiKey,
  requestJson: requestJson,
});

function isValidTranslationBatch(texts, contexts) {
  if (!Array.isArray(texts) || texts.length === 0) return false;
  if (texts.length > MAX_TRANSLATION_TEXTS) return false;
  if (
    contexts !== undefined &&
    (!Array.isArray(contexts) ||
      contexts.length !== texts.length ||
      contexts.some(
        (context) => typeof context !== "string" || context.length > 400
      ))
  ) {
    return false;
  }
  let totalChars = 0;
  for (const text of texts) {
    if (typeof text !== "string" || text.trim() === "") return false;
    if (text.length > MAX_TRANSLATION_CHARS) return false;
    totalChars += text.length;
  }
  return totalChars <= MAX_TRANSLATION_CHARS;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;

  if (message.type === "lookup") {
    (async () => {
      if (!WordUtils.isValidWord(message.word)) {
        sendResponse({ ok: false, error: "INVALID" });
        return;
      }
      const word = WordUtils.normalizeWord(message.word);
      let context = null;
      if (typeof message.context === "string" && message.context.trim() !== "") {
        context = message.context.trim().slice(0, 400);
      }
      sendResponse(await lookup(word, context));
    })();
    return true; // 异步 sendResponse
  }

  if (message.type === "translateBatch") {
    (async () => {
      if (!isValidTranslationBatch(message.texts, message.contexts)) {
        sendResponse({ ok: false, error: "INVALID" });
        return;
      }
      sendResponse(await translateBatch(message.texts, message.contexts));
    })();
    return true; // 异步 sendResponse
  }
});
