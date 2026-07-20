const fs = require('fs');
const assert = require('assert');

const server = fs.readFileSync('server.js', 'utf8');
const view = fs.readFileSync('public/js/views/AnalyticsCenter.js', 'utf8');
const main = fs.readFileSync('public/js/main.js', 'utf8');
const html = fs.readFileSync('public/index.html', 'utf8');

assert.match(server, /WHERE active = TRUE AND user_id = \$1/);
assert.match(view, /\/api\/seller\/dashboard/);
assert.match(view, /\/api\/seller\/analytics\/categories/);
assert.match(view, /\/api\/seller\/analytics\/bestsellers/);
assert.match(view, /profitRows/);
assert.match(view, /purchase_cost_cny/);
assert.match(server, /profit_is_estimated/);
assert.match(server, /commissionCny \* qty/);
assert.match(view, /采购价缺失时显示估算利润/);
assert.match(main, /analytics-center-view/);
assert.match(html, /AnalyticsCenter\.js/);
console.log('Analytics center structural checks passed.');
