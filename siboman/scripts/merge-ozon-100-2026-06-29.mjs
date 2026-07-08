import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { writeJobArtifacts } from "../server.js";

const ROOT = "/Users/eason/Documents/OZON";
const JOBS_DIR = path.join(ROOT, "data", "jobs");
const DOWNLOADS_DIR = "/Users/eason/Downloads";
const OUTPUT_ID = `combined-ozon-100-2026-06-29-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const OUTPUT_DIR = path.join(JOBS_DIR, OUTPUT_ID);

const sourceJobIds = [
  "150f6164-a757-4690-8011-aa2ae87be970",
  "6b09d3d7-4933-427b-a00f-491eebb75897",
  "da8721f7-4766-4b1c-951a-71c2feb4b309",
  "125af080-5377-4e3f-b328-8c92056ca8e4",
  "bb210e64-63b3-4af1-85ee-9981ba2a7c6a",
  "9a0ce37e-bb24-4fa9-9e16-5323aa19c532",
];

const selectedByRow = new Map();
const sourceSummaries = [];

for (const jobId of sourceJobIds) {
  const jsonPath = path.join(JOBS_DIR, jobId, "results.json");
  const raw = JSON.parse(await fs.readFile(jsonPath, "utf8"));
  const rows = (raw.results || [])
    .map((result) => Number(result.sourceRow))
    .filter(Number.isFinite)
    .filter((row) => row >= 1 && row <= 100)
    .sort((a, b) => a - b);
  sourceSummaries.push({
    id: jobId,
    status: raw.status,
    firstRow: rows[0] || "",
    lastRow: rows.at(-1) || "",
    count: rows.length,
  });
  for (const result of raw.results || []) {
    const row = Number(result.sourceRow);
    if (Number.isFinite(row) && row >= 1 && row <= 100) {
      selectedByRow.set(row, result);
    }
  }
}

const missingRows = [];
for (let row = 1; row <= 100; row += 1) {
  if (!selectedByRow.has(row)) missingRows.push(row);
}

const results = Array.from(selectedByRow.entries())
  .sort(([a], [b]) => a - b)
  .map(([, result]) => result);

await fs.mkdir(OUTPUT_DIR, { recursive: true });

const now = new Date().toISOString();
const job = {
  id: OUTPUT_ID,
  status: "done",
  phase: `已合并 2026-06-29 批次结果，可用 ${results.length}/100 条`,
  createdAt: now,
  updatedAt: now,
  total: results.length,
  processed: results.length,
  sourceStartRow: 1,
  sourceTotal: 100,
  results,
  logs: [
    {
      at: now,
      level: "info",
      message: `合并来源：${sourceSummaries.map((item) => `${item.id}(${item.firstRow}-${item.lastRow}, ${item.count}条)`).join("；")}`,
    },
    {
      at: now,
      level: missingRows.length ? "warn" : "info",
      message: missingRows.length ? `缺少原始行号：${missingRows.join(", ")}` : "1-100 行结果完整。",
    },
  ],
  error: missingRows.length ? `缺少原始行号：${missingRows.join(", ")}` : "",
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

const downloadName = `ozon-1688-merged-2026-06-29-${results.length}-of-100.xlsx`;
const downloadPath = path.join(DOWNLOADS_DIR, downloadName);
await fs.copyFile(sourceExcel, downloadPath);

console.log(JSON.stringify({
  outputId: OUTPUT_ID,
  rows: results.length,
  missingRows,
  firstRow: results[0]?.sourceRow,
  lastRow: results.at(-1)?.sourceRow,
  sourceExcel,
  downloadPath,
  sources: sourceSummaries,
}, null, 2));
