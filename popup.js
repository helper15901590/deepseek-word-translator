const keyInput = document.getElementById("key");
const statusEl = document.getElementById("status");
const translateButton = document.getElementById("translate");

function showStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", !!isError);
}

const TRANSLATION_ERRORS = {
  NO_KEY: "请先保存 DeepSeek API Key",
  AUTH: "API Key 无效或已过期",
  SERVER: "DeepSeek 服务暂时不可用，请稍后再试",
  NETWORK: "网络请求失败，网页翻译已中断",
  PARSE: "翻译结果解析失败，请重试",
  HTTP: "网页翻译请求失败",
  INVALID: "当前网页没有可翻译的内容",
  NO_CONTENT: "当前页面没有找到需要翻译的英文内容",
  BUSY: "网页正在翻译中，请稍候",
};

function translationErrorText(result) {
  const code = result && result.error;
  const base = TRANSLATION_ERRORS[code] || "网页翻译失败，请稍后重试";
  if (result && Number.isInteger(result.translated) && result.translated > 0) {
    return base + "（已完成 " + result.translated + " 段）";
  }
  return base;
}

// 只有顶层框架回复，故计数口径是顶层文档；内嵌框架各自翻译并显示自己的进度
function translationSuccessText(result) {
  const base = "翻译完成，共 " + result.data.translated + " 段";
  if (result.data.frames > 0) {
    return base + "；页面内嵌框架的进度见各框架右下角";
  }
  return base;
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

translateButton.addEventListener("click", async () => {
  translateButton.disabled = true;
  showStatus("正在翻译当前网页…", false);
  try {
    const tabs = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const tab = tabs && tabs[0];
    if (!tab || typeof tab.id !== "number") {
      showStatus("没有找到当前网页", true);
      return;
    }
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: "translatePage",
    });
    if (!result || !result.ok) {
      // 顶层文档没有英文，但页面内嵌框架可能有：此时不是失败
      if (result && result.error === "NO_CONTENT" && result.frames > 0) {
        showStatus(
          "主文档没有可翻译的英文内容；内嵌框架的进度见各框架右下角",
          false
        );
        return;
      }
      showStatus(translationErrorText(result), true);
      return;
    }
    showStatus(translationSuccessText(result), false);
  } catch (e) {
    showStatus("当前页面无法翻译；请确认不是 Chrome 内置页面，并刷新后重试", true);
  } finally {
    translateButton.disabled = false;
  }
});
