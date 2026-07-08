/**
 * 逐梦 Ozon 采集器 - Content Bridge (MAIN world) v2.1.2
 *
 * v2.1.2: 此文件已废弃职责 - ISO reply 改走 chrome.storage 不需要 MAIN 桥.
 *   保留此文件因为 manifest.json 必须有两个 content_scripts 块,
 *   manifest 改 content_scripts 风险大. 这里只做一件事: 让 manifest 不报错.
 *   实际是空 IIFE.
 */
(function () {
  "use strict";
  // v2.1.2: noop - 之前 postMessage override / addEventListener 拦截 / messageHandlers dispatch
  //   都已废弃, reply 走 chrome.storage.onChanged, request 走 ISO 自己 dispatch 的 __zhumeng_request__
  //   CustomEvent (document 跨 world 投递对 forward 方向工作, 只有 reply back 不可靠).
})();
