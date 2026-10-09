const DEFAULT_READLATER_URL = "http://127.0.0.1:3000";

const statusEl = document.querySelector("#status");
const saveButton = document.querySelector("#save");
const openButton = document.querySelector("#open");
const saveConfigButton = document.querySelector("#save-config");
const baseUrlInput = document.querySelector("#base-url");
const tokenInput = document.querySelector("#token");

function setStatus(message) {
  statusEl.textContent = message;
}

function normalizeBaseUrl(value) {
  return (value || DEFAULT_READLATER_URL).trim().replace(/\/+$/, "");
}

async function getConfig() {
  const stored = await chrome.storage.local.get(["baseUrl", "token"]);
  return {
    baseUrl: normalizeBaseUrl(stored.baseUrl),
    token: stored.token || ""
  };
}

async function loadConfig() {
  const config = await getConfig();
  baseUrlInput.value = config.baseUrl;
  tokenInput.value = config.token;
}

async function saveConfig() {
  await chrome.storage.local.set({
    baseUrl: normalizeBaseUrl(baseUrlInput.value),
    token: tokenInput.value.trim()
  });
  setStatus("设置已保存。");
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function canCaptureTab(tab) {
  return Boolean(tab?.id && /^https?:\/\//i.test(tab.url || ""));
}

async function captureCurrentPage(tab) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content-normalization.js", "content-script.js"]
  });
  return result.result;
}

async function saveCurrentPage() {
  saveButton.disabled = true;
  setStatus("正在读取页面...");
  try {
    await saveConfig();
    const config = await getConfig();

    const tab = await getActiveTab();
    if (!canCaptureTab(tab)) {
      setStatus("请在普通网页上使用，不能保存扩展页、新标签页或浏览器设置页。");
      return;
    }

    const payload = await captureCurrentPage(tab);
    setStatus("正在保存...");
    const headers = { "Content-Type": "application/json" };
    if (config.token) headers.Authorization = `Bearer ${config.token}`;
    const response = await fetch(`${config.baseUrl}/api/clip/page`, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "保存失败");
    if (data.duplicate && data.updated) setStatus("已更新已保存内容。");
    else setStatus(data.duplicate ? "已经保存过了。" : "已保存到 Inbox。");
  } catch (error) {
    setStatus(error.message === "Authentication required" ? "请先打开 Readlater 登录，或在设置里填写 Bearer Token。" : error.message);
  } finally {
    saveButton.disabled = false;
  }
}

saveButton.addEventListener("click", saveCurrentPage);
saveConfigButton.addEventListener("click", saveConfig);
openButton.addEventListener("click", async () => {
  const config = await getConfig();
  chrome.tabs.create({ url: config.baseUrl });
});

loadConfig();
