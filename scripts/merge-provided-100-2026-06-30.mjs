import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { writeJobArtifacts } from "../server.js";

const ROOT = "/Users/eason/Documents/OZON";
const JOBS_DIR = path.join(ROOT, "data", "jobs");
const DOWNLOADS_DIR = "/Users/eason/Downloads";
const OUTPUT_ID = `combined-provided-100-2026-06-30-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const OUTPUT_DIR = path.join(JOBS_DIR, OUTPUT_ID);

const productIds = `
4253974150
4029943188
3960164799
3120498264
2964619585
3583846354
3547166294
4192493741
3607772245
4012166426
2724224605
3137327028
2771011513
2730359866
2724227730
2512705993
1931135341
3076716770
1984150192
3915766140
2859279580
3915766340
2883611348
3185435862
2898585043
2898577469
2898570232
2365455053
3080772195
3137326989
3062972427
3924275230
2898567988
3421366752
3475277028
3449841627
3592211975
3076842465
3058968408
3184690299
3058944445
3013783896
4081302937
4677740818
4651707697
4426821044
4426567922
3489381264
4227284732
4449229000
4782113704
4098083693
4747692655
4524693430
3829366203
3109417603
3990469144
2845970854
3367568179
2488363836
3384695403
4117224408
3723962030
3362716093
3595531739
3362715087
3358026234
4371423216
4458963784
2076824727
2132041424
2021805797
1996917268
1595908136
2076825466
2151142887
3740610852
3891600852
2014734390
3921030223
3690522275
3740594235
3198681875
3690457848
1962889216
1962790689
3604397641
3854551960
3921033847
1782166383
4539638085
3198682849
4467792445
2921274087
3891611715
1962889034
3789888077
1799477633
3900523246
3891650250
`.trim().split(/\s+/);

const byRow = new Map();
const sourceSummaries = new Map();

for (const jobId of await fs.readdir(JOBS_DIR)) {
  const jsonPath = path.join(JOBS_DIR, jobId, "results.json");
  if (!existsSync(jsonPath)) continue;
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(jsonPath, "utf8"));
  } catch {
    continue;
  }

  const matchedRows = [];
  const score = Date.parse(raw.updatedAt || raw.createdAt || 0) || 0;
  for (const result of raw.results || []) {
    const haystack = [
      result.url,
      result.ozon?.sourceUrl,
      result.ozon?.sku,
    ].filter(Boolean).join(" ");
    const rowIndex = productIds.findIndex((productId) => haystack.includes(productId));
    if (rowIndex < 0) continue;
    const sourceRow = rowIndex + 1;
    matchedRows.push(sourceRow);
    const existing = byRow.get(sourceRow);
    if (!existing || score > existing.score) {
      byRow.set(sourceRow, {
        score,
        jobId: raw.id || jobId,
        result: {
          ...result,
          sourceRow,
          url: `https://www.ozon.ru/product/${productIds[rowIndex]}`,
        },
      });
    }
  }

  if (matchedRows.length) {
    matchedRows.sort((a, b) => a - b);
    sourceSummaries.set(raw.id || jobId, {
      id: raw.id || jobId,
      status: raw.status,
      firstRow: matchedRows[0],
      lastRow: matchedRows.at(-1),
      count: matchedRows.length,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    });
  }
}

const missingRows = [];
for (let row = 1; row <= productIds.length; row += 1) {
  if (!byRow.has(row)) missingRows.push(row);
}
if (missingRows.length) {
  throw new Error(`合并结果缺少原始行号：${missingRows.join(", ")}`);
}

const results = Array.from(byRow.entries())
  .sort(([a], [b]) => a - b)
  .map(([, item]) => item.result);

await fs.mkdir(OUTPUT_DIR, { recursive: true });

const now = new Date().toISOString();
const sources = Array.from(sourceSummaries.values())
  .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
const job = {
  id: OUTPUT_ID,
  status: "done",
  phase: "已按用户提供的 100 条链接合并结果",
  createdAt: now,
  updatedAt: now,
  total: results.length,
  processed: results.length,
  sourceStartRow: 1,
  sourceTotal: productIds.length,
  results,
  logs: [
    {
      at: now,
      level: "info",
      message: `合并来源：${sources.map((item) => `${item.id}(${item.firstRow}-${item.lastRow}, ${item.count}条)`).join("；")}`,
    },
    {
      at: now,
      level: "info",
      message: "100 条链接均已匹配到结果；重复行按最新结果保留。",
    },
  ],
  error: "",
  consecutiveFailures: 0,
  verification: null,
  cancelRequested: false,
  downloadUrl: null,
};

await writeJobArtifacts(job);

const sourceExcel = path.join(OUTPUT_DIR, "ozon-1688-results.xlsx");
if (!existsSync(sourceExcel)) {
  throw new Error(`没有生成 Excel：${sourceExcel}`);
}

const downloadPath = path.join(DOWNLOADS_DIR, "ozon-1688-merged-provided-100-2026-06-30.xlsx");
await fs.copyFile(sourceExcel, downloadPath);

console.log(JSON.stringify({
  outputId: OUTPUT_ID,
  rows: results.length,
  firstRow: results[0]?.sourceRow,
  lastRow: results.at(-1)?.sourceRow,
  sourceExcel,
  downloadPath,
  sources,
}, null, 2));
