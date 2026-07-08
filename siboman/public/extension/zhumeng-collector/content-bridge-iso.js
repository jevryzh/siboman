/**
 * 逐梦 Ozon 采集器 - Content Bridge (ISOLATED world) v2.1.4
 *
 * v2.1.4 终极修复 - forward + reply 双向全用 window.postMessage:
 *   - 之前 v2.1.3 仍用 document CustomEvent `__zhumeng_request__` 跨世界投递, 在 Chrome MV3
 *     下不可靠: 实测 ping/status ISO 都收到 (因为 ISO listener 注册时 dispatch path 正常)
 *     但 collect.request 派发后 ISO 那边 "收到" 这行 log 不出现 - 说明 customEvent 跨世界
 *     投递本身就有边界 case bug, 不是 listener 收不到, 是 messageEvent 根本没到 isolated world.
 *   - 改用 window.postMessage: 这是 Chrome 官方为跨 world 通信设计的标准 API. Spec 保证:
 *     - main world postMessage → isolated world's window 'message' listeners 收到
 *     - isolated world postMessage → main world's window 'message' listeners 收到
 *     - 同 world 自己 dispatch 不触发自己 world's 'message' listeners (no bounce-back).
 */
(function () {
  "use strict";
  const PROTO = "__zhumeng_proto";
  const PROTO_VAL = "zhumeng-v1";
  const VERSION = "2.1.4";

  console.log(`[逐梦采集器 v${VERSION}][ISO] 启动, 监听 window message`);

  // v2.1.4: reply 用 window.postMessage 跨 world 投递回 main world ERP
  function replyToMain(reqId, kind, payload) {
    const replyMsg = { [PROTO]: PROTO_VAL, reqId, kind, ts: Date.now(), ...payload };
    window.postMessage(replyMsg, '*');
    console.log(`[逐梦采集器 v${VERSION}][ISO] → reply ${kind} reqId=${reqId?.slice(0, 20) || "?"}`);
  }

  function broadcastReady(version) {
    window.postMessage({ [PROTO]: PROTO_VAL, kind: "ready", version }, '*');
    console.log(`[逐梦采集器 v${VERSION}][ISO] broadcast ready via window.postMessage`);
  }

  // 监听 main world dispatch (via postMessage) 的 request
  window.addEventListener("message", async (event) => {
    const data = event.data;
    if (!data || typeof data !== "object" || data[PROTO] !== PROTO_VAL) return;
    if (!data.kind?.endsWith(".request")) return;

    const { reqId, kind } = data;
    console.log(`[逐梦采集器 v${VERSION}][ISO] 收到 kind=${kind} reqId=${reqId?.slice(0, 20) || "?"}`);

    if (kind === "ping.request") {
      chrome.runtime.sendMessage({ action: "ping" }).catch(() => {});
      replyToMain(reqId, "ping.response", { ok: true, version: VERSION });
      return;
    }

    if (kind === "status.request") {
      try {
        const resp = await chrome.runtime.sendMessage({ action: "checkStatus" });
        replyToMain(reqId, "status.response", resp);
      } catch (e) {
        replyToMain(reqId, "status.response", { ok: false, error: e.message });
      }
      return;
    }

    if (kind === "diagnose.request") {
      try {
        const resp = await chrome.runtime.sendMessage({ action: "diagnose" });
        replyToMain(reqId, "diagnose.response", resp);
      } catch (e) {
        replyToMain(reqId, "diagnose.response", { ok: false, error: e.message });
      }
      return;
    }

    if (kind === "collect.request") {
      const skus = data.skus || [];
      const storeIds = data.storeIds || [];
      console.log(`[逐梦采集器 v${VERSION}][ISO] collect.request: ${skus.length} SKU, ${storeIds.length} stores`);
      if (!skus.length) {
        replyToMain(reqId, "collect.response", { ok: false, error: "skus 为空" });
        return;
      }
      try {
        const resp = await chrome.runtime.sendMessage({ action: "collectSkus", skus, storeIds });
        console.log(`[逐梦采集器 v${VERSION}][ISO] collect 完成 ok=${resp?.ok} 成功=${Object.keys(resp?.results || {}).length}`);
        replyToMain(reqId, "collect.response", resp);
      } catch (e) {
        console.error(`[逐梦采集器 v${VERSION}][ISO] collect 异常:`, e.message);
        replyToMain(reqId, "collect.response", { ok: false, error: e.message });
      }
      return;
    }
  });

  // 持续 broadcast ready
  let readyCount = 0;
  const tick = () => {
    if (readyCount >= 10) return;
    broadcastReady(VERSION);
    readyCount++;
    setTimeout(tick, 1000);
  };
  tick();
})();
