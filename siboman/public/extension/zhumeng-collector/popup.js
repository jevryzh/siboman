const statusEl = document.getElementById("status");

async function checkStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ action: "checkStatus" });
    if (resp.ok && resp.seller_connected) {
      statusEl.className = "status status-ok";
      statusEl.textContent = "✅ Ozon 登录态: 有效" + (resp.session_valid ? " (Session)" : " (标签页)");
    } else if (resp.ok) {
      statusEl.className = "status status-err";
      statusEl.textContent = "❌ Ozon 登录态: 无效, 请先登录 seller.ozon.ru";
    } else {
      statusEl.className = "status status-err";
      statusEl.textContent = "❌ " + (resp.error || "检测失败");
    }
  } catch (e) {
    statusEl.className = "status status-err";
    statusEl.textContent = "❌ 插件异常: " + e.message;
  }
}

document.getElementById("openSeller").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://seller.ozon.ru/app/products" });
});

document.getElementById("openErp").addEventListener("click", () => {
  chrome.tabs.create({ url: "http://test.renwz.cn/#/upload" });
});

checkStatus();
