import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/extension/zhumeng-collector/background.js', import.meta.url), 'utf8');
const start = source.indexOf('func: async function (postingNumbers) {', source.indexOf('if (msg.action === "printLabels")'));
const end = source.indexOf('\n          },\n          args: [postingNumbers]', start);
assert.ok(start >= 0 && end > start, 'printLabels injected function exists');
const fnSource = source.slice(start + 'func: '.length, end + '\n          }'.length);
let active = 0;
let maximum = 0;
const fetch = async (path, options) => {
  const body = JSON.parse(options.body);
  if (path.endsWith('/create')) {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, body.posting_numbers[0] === 'A' ? 12 : 2));
    active -= 1;
    return { status: 200, text: async () => JSON.stringify({ tasks: [{ task_id: body.posting_numbers[0] }] }) };
  }
  if (body.task_id === 'B') throw new Error('temporary failure');
  return { status: 200, text: async () => JSON.stringify({ url: `https://cdn.example.com/${body.task_id}.pdf` }) };
};
const fn = vm.runInNewContext(`(${fnSource})`, { document: { cookie: 'sc_company_id=123' }, fetch, setTimeout, AbortSignal });
const result = await fn(['A', 'B', 'C', 'D']);
assert.equal(result.ok, true);
assert.ok(maximum <= 1, `at most 1 concurrent task, got ${maximum}`);
assert.deepEqual(Array.from(result.items, (item) => item.pn), ['A', 'C', 'D']);
assert.deepEqual(Array.from(result.failed, (item) => item.pn), ['B']);
console.log('yarn label parallel order and failure isolation: OK');
