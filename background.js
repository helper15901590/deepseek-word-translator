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
  makeKey: Lookup.makeContextKey,
  cache: {
    get: (key) => cache.get(key),
    set: (key, data) => {
      cache.set(key, data);
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
    let context = null;
    if (typeof message.context === "string" && message.context.trim() !== "") {
      context = message.context.trim().slice(0, 400);
    }
    sendResponse(await lookup(word, context));
  })();
  return true; // 异步 sendResponse
});
