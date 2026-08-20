const keyInput = document.getElementById("key");
const statusEl = document.getElementById("status");

function showStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", !!isError);
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
