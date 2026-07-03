const DEFAULT_SERVER_URL = "http://xm.renwz.cn";
const HEARTBEAT_ALARM = "ozon1688CollectorHeartbeat";
const HEARTBEAT_MINUTES = 1;

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(["serverUrl", "workerName"]);
  const updates = {};
  if (!stored.serverUrl) updates.serverUrl = DEFAULT_SERVER_URL;
  if (!stored.workerName) updates.workerName = defaultWorkerName();
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) {
    heartbeat().catch((error) => setState({ lastError: error.message, online: false }));
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

async function handleMessage(message = {}) {
  if (message.type === "get-state") return getPublicState();
  if (message.type === "login") return login(message);
  if (message.type === "logout") return logout();
  if (message.type === "start") return start();
  if (message.type === "stop") return stop();
  if (message.type === "heartbeat") return heartbeat();
  throw new Error("未知操作。");
}

async function login({ serverUrl, username, password }) {
  const normalizedServerUrl = normalizeServerUrl(serverUrl || DEFAULT_SERVER_URL);
  const cleanUsername = String(username || "").trim();
  const cleanPassword = String(password || "");
  if (!cleanUsername || !cleanPassword) throw new Error("请输入 ERP 账号和密码。");

  const response = await fetch(`${normalizedServerUrl}/api/extension/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: cleanUsername, password: cleanPassword }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success || !data.token) {
    throw new Error(data.error || `登录失败：HTTP ${response.status}`);
  }
  await chrome.storage.local.set({
    serverUrl: normalizedServerUrl,
    username: cleanUsername,
    token: data.token,
    user: data.user || null,
    workerName: defaultWorkerName(),
    running: true,
    lastError: "",
  });
  await start();
  return getPublicState();
}

async function logout() {
  await chrome.alarms.clear(HEARTBEAT_ALARM);
  await chrome.storage.local.remove(["token", "user", "running", "lastError", "lastSeenAt", "queue", "online"]);
  return getPublicState();
}

async function start() {
  const state = await getStoredState();
  if (!state.token) throw new Error("请先登录。");
  await chrome.storage.local.set({ running: true, workerName: state.workerName || defaultWorkerName() });
  await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_MINUTES });
  await heartbeat();
  return getPublicState();
}

async function stop() {
  await chrome.alarms.clear(HEARTBEAT_ALARM);
  await chrome.storage.local.set({ running: false, online: false });
  return getPublicState();
}

async function heartbeat() {
  const state = await getStoredState();
  if (!state.running || !state.token) return getPublicState();
  const body = {
    workerName: state.workerName || defaultWorkerName(),
    platform: platformLabel(),
    hostname: state.workerName || defaultWorkerName(),
    profileDir: "browser-extension",
    currentPhase: "浏览器插件在线（预览版，暂不领取任务）",
  };
  const response = await fetch(`${state.serverUrl}/api/worker/heartbeat`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${state.token}`,
      "Content-Type": "application/json",
      "X-Worker-Name": body.workerName,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new Error(data.error || `心跳失败：HTTP ${response.status}`);
  }
  await setState({
    online: true,
    lastSeenAt: new Date().toISOString(),
    lastError: "",
    queue: data.queue || null,
  });
  return getPublicState();
}

async function getStoredState() {
  const stored = await chrome.storage.local.get([
    "serverUrl",
    "username",
    "token",
    "user",
    "workerName",
    "running",
    "online",
    "lastSeenAt",
    "lastError",
    "queue",
  ]);
  return {
    serverUrl: normalizeServerUrl(stored.serverUrl || DEFAULT_SERVER_URL),
    username: stored.username || "",
    token: stored.token || "",
    user: stored.user || null,
    workerName: stored.workerName || defaultWorkerName(),
    running: Boolean(stored.running),
    online: Boolean(stored.online),
    lastSeenAt: stored.lastSeenAt || "",
    lastError: stored.lastError || "",
    queue: stored.queue || null,
  };
}

async function getPublicState() {
  const state = await getStoredState();
  return {
    serverUrl: state.serverUrl,
    username: state.username,
    user: state.user,
    workerName: state.workerName,
    running: state.running,
    online: state.online,
    lastSeenAt: state.lastSeenAt,
    lastError: state.lastError,
    queue: state.queue,
  };
}

async function setState(patch) {
  await chrome.storage.local.set(patch);
}

function normalizeServerUrl(value) {
  let text = String(value || DEFAULT_SERVER_URL).trim();
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
  return text.replace(/\/+$/, "");
}

function defaultWorkerName() {
  const browser = navigator.userAgent.includes("Edg/") ? "Edge" : "Chrome";
  return `${browser}-插件-${chrome.runtime.id.slice(0, 6)}`;
}

function platformLabel() {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "win32";
  if (/Mac OS X/i.test(ua)) return "darwin";
  if (/Linux/i.test(ua)) return "linux";
  return "browser-extension";
}
