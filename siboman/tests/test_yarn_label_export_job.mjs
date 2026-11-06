import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { buildOrderedYarnLabels } from '../lib/yarn-label-export.js';

const makePdf = async (width) => {
  const doc = await PDFDocument.create();
  doc.addPage([width, 200]);
  return Buffer.from(await doc.save());
};
const pdfs = { A: await makePdf(101), B: await makePdf(102), C: await makePdf(103) };
const attempts = {};
const progress = [];
const fetchImpl = async (_url, options) => {
  const posting = JSON.parse(options.body).posting_number[0];
  attempts[posting] = (attempts[posting] || 0) + 1;
  if (posting === 'A') await new Promise((resolve) => setTimeout(resolve, 10));
  if (posting === 'B' && attempts[posting] === 1) {
    return { status: 429, ok: false, headers: { get: () => 'application/json' }, arrayBuffer: async () => Buffer.from('{"error":"rate limit"}') };
  }
  return { status: 200, ok: true, headers: { get: () => 'application/pdf' }, arrayBuffer: async () => pdfs[posting] };
};
const result = await buildOrderedYarnLabels(['A', 'B', 'C'], {
  baseUrl: 'https://example.test', clientId: 'test', apiKey: 'test', fetchImpl,
  sleep: async () => {}, onProgress: (item) => progress.push(item),
});
const merged = await PDFDocument.load(result);
assert.deepEqual(merged.getPages().map((page) => page.getWidth()), [101, 102, 103]);
assert.equal(attempts.B, 2);
assert.equal(progress.at(-1).completed, 3);
assert.equal(progress.at(-1).rateLimited, 1);

await assert.rejects(buildOrderedYarnLabels(['A', 'bad', 'C'], {
  baseUrl: 'https://example.test', clientId: 'test', apiKey: 'test', sleep: async () => {},
  fetchImpl: async (_url, options) => {
    const posting = JSON.parse(options.body).posting_number[0];
    if (posting === 'bad') return { status: 500, ok: false, headers: { get: () => 'application/json' }, arrayBuffer: async () => Buffer.from('{"error":"upstream"}') };
    return { status: 200, ok: true, headers: { get: () => 'application/pdf' }, arrayBuffer: async () => pdfs[posting] };
  },
}), /货件 bad 获取标签失败.*没有生成不完整的 PDF/);
console.log('yarn label async export order, retry, and failure: OK');
