/**
 * ozon.ru 上的「占位」内容脚本（v2.2.9.128）
 *
 * 为什么需要它：巡查跟卖要在 https://www.ozon.ru/product/<sku>/ 页面上用
 * chrome.scripting.executeScript 注入函数，去读商品卡片上的其他卖家。
 * 而 executeScript 只认 Chrome 的 scriptable_hosts —— 它由 content_scripts.matches
 * 决定。之前 manifest 只把 ERP 域名写进了 content_scripts，ozon 域名只在
 * host_permissions 里，结果 scriptable_hosts 里没有 ozon，注入直接报：
 *   "Cannot access contents of the page. Extension manifest must request
 *    permission to access the respective host."
 * 把 ozon 域名加进 content_scripts（配这个空脚本）后，ozon 就是可注入的了，
 * 也不再依赖用户在 chrome://extensions 里手动把「网站访问权限」改成「在所有网站上」。
 *
 * 本文件故意什么都不做，只是为了拿到可注入权限。
 */
(function () {
  try {
    // 仅留一个痕迹便于排查；不做任何 DOM 改动，避免干扰 Ozon 页面。
    if (window.top === window) {
      window.__zhumengOzonInjectable = true;
    }
  } catch (_e) { /* 忽略 */ }
})();
