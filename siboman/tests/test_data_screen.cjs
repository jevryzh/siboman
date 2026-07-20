const fs = require('fs');
const assert = require('assert');
const server = fs.readFileSync('server.js', 'utf8');
const view = fs.readFileSync('public/js/views/DataScreen.js', 'utf8');
const main = fs.readFileSync('public/js/main.js', 'utf8');

assert.match(server, /recent_orders: recentOrders/);
assert.match(server, /stock_warnings: stockWarnings/);
assert.match(server, /range \* 86400e3/);
assert.match(view, /setInterval\(refresh, 30000\)/);
assert.match(view, /requestFullscreen/);
assert.match(view, /fullscreenchange/);
assert.match(view, /recent_orders/);
assert.match(view, /stock_warnings/);
assert.match(main, /data-screen-view/);
console.log('Data screen structural checks passed.');
