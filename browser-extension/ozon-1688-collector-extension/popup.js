const serverUrlInput = document.getElementById("serverUrlInput");
const usernameInput = document.getElementById("usernameInput");
const passwordInput = document.getElementById("passwordInput");
const loginBtn = document.getElementById("loginBtn");
const heartbeatBtn = document.getElementById("heartbeatBtn");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const logoutBtn = document.getElementById("logoutBtn");
const onlinePill = document.getElementById("onlinePill");
const workerNameText = document.getElementById("workerNameText");
const accountText = document.getElementById("accountText");
const queueText = document.getElementById("queueText");
const lastSeenText = document.getElementById("lastSeenText");
const noticeText = document.getElementById("noticeText");
const versionText = document.getElementById("versionText");

init();

loginBtn.addEventListener("click", async () => {
  await runAction("正在登录...", () => sendMessage({
    type: "login",
    serverUrl: serverUrlInput.value,
    username: usernameInput.value,
    password: passwordInput.value,
  }));
  passwordInput.value = "";
});

heartbeatBtn.addEventListener("click", () => runAction("正在同步状态...", () => sendMessage({ type: "heartbeat" })));
startBtn.addEventListener("click", () => runAction("正在保持在线...", () => sendMessage({ type: "start" })));
stopBtn.addEventListener("click", () => runAction("正在暂停...", () => sendMessage({ type: "stop" })));
logoutBtn.addEventListener("click", () => runAction("正在退出...", () => sendMessage({ type: "logout" })));

async function init() {
  try {
    const manifest = chrome.runtime.getManifest();
    versionText.textContent = `浏览器插件版 v${manifest.version}`;
  } catch {
    versionText.textContent = "浏览器插件版";
  }
  const state = await sendMessage({ type: "get-state" });
  renderState(state);
}

async function runAction(loadingText, action) {
  setBusy(true);
  setNotice(loadingText, "");
  try {
    const state = await action();
    renderState(state);
    setNotice(state.online ? "已连接 ERP，网页端可以看到本插件在线。" : "状态已更新。", state.online ? "good" : "warn");
  } catch (error) {
    setNotice(error.message || "操作失败。", "bad");
  } finally {
    setBusy(false);
  }
}

async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "插件后台没有响应。");
  delete response.ok;
  return response;
}

function renderState(state = {}) {
  serverUrlInput.value = state.serverUrl || "http://xm.renwz.cn";
  usernameInput.value = state.username || "";
  onlinePill.textContent = state.online && state.running ? "在线" : state.running ? "连接中" : "离线";
  onlinePill.classList.toggle("online", Boolean(state.online && state.running));
  workerNameText.textContent = state.workerName || "-";
  accountText.textContent = state.user?.username || state.username || "未登录";
  queueText.textContent = state.queue ? `排队 ${state.queue.queued || 0} / 执行 ${state.queue.active || 0}` : "-";
  lastSeenText.textContent = state.lastSeenAt ? formatTime(state.lastSeenAt) : "-";
  if (state.lastError) setNotice(state.lastError, "bad");
}

function setBusy(busy) {
  [loginBtn, heartbeatBtn, startBtn, stopBtn, logoutBtn].forEach((button) => {
    button.disabled = busy;
  });
}

function setNotice(text, tone = "") {
  noticeText.textContent = text;
  noticeText.className = `notice ${tone}`.trim();
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", { hour12: false });
}
