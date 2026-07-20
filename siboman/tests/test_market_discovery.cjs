const fs = require('fs');
const assert = require('assert');
const server = fs.readFileSync('server.js', 'utf8');
const view = fs.readFileSync('public/js/views/MarketDiscovery.js', 'utf8');
const main = fs.readFileSync('public/js/main.js', 'utf8');

for (const table of ['app_top_lists', 'app_china_sellers']) assert(server.includes(`CREATE TABLE IF NOT EXISTS ${table}`));
for (const route of ['/api/sourcing/bestsellers', '/api/sourcing/bestsellers/import', '/api/sourcing/china-zone', '/api/sourcing/china-zone/verify']) assert(server.includes(route));
assert.match(server, /source_name\/source_captured_at/);
assert.match(server, /req\.user\.role !== 'admin'/);
assert.match(server, /confidence: 0\.65/);
assert.match(server, /isChina: false, confidence: 0\.65/);
assert.match(view, /独立公共数据源/);
assert.match(view, /addToCollection/);
assert.doesNotMatch(view, /single-sourcing|1688|找货/);
assert.match(main, /market-discovery-view/);
console.log('Market discovery structural checks passed.');
