import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { writeJobArtifacts } from "../server.js";

const ROOT = "/Users/eason/Documents/OZON";
const JOBS_DIR = path.join(ROOT, "data", "jobs");
const OUTPUT_ID = `combined-ozon-300-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const OUTPUT_DIR = path.join(JOBS_DIR, OUTPUT_ID);
const DOWNLOADS_DIR = "/Users/eason/Downloads";

const sourceJobIds = [
  "ca899947-5716-4a2c-9602-6373030dbb6c",
  "09dff918-b333-4d7b-bb04-930c384cb237",
  "302db5d9-dc60-44b5-a1c0-28c573929151",
  "f9e1dbdd-8d9a-4078-94ab-ac60665790ac",
];

const selectedByRow = new Map();
const sourceSummaries = [];

for (const jobId of sourceJobIds) {
  const jsonPath = path.join(JOBS_DIR, jobId, "results.json");
  const raw = JSON.parse(await fs.readFile(jsonPath, "utf8"));
  const rows = (raw.results || [])
    .map((result) => Number(result.sourceRow))
    .filter(Number.isFinite);
  sourceSummaries.push({
    id: jobId,
    status: raw.status,
    firstRow: rows.length ? Math.min(...rows) : "",
    lastRow: rows.length ? Math.max(...rows) : "",
    count: rows.length,
  });
  for (const result of raw.results || []) {
    const row = Number(result.sourceRow);
    if (Number.isFinite(row) && row >= 1 && row <= 300) {
      selectedByRow.set(row, result);
    }
  }
}

const missingRows = [];
for (let row = 1; row <= 300; row += 1) {
  if (!selectedByRow.has(row)) missingRows.push(row);
}
if (missingRows.length) {
  throw new Error(`合并结果缺少原始行号：${missingRows.join(", ")}`);
}

const results = Array.from(selectedByRow.entries())
  .sort(([a], [b]) => a - b)
  .map(([, result]) => result);

await fs.mkdir(OUTPUT_DIR, { recursive: true });

const job = {
  id: OUTPUT_ID,
  status: "done",
  phase: "已合并 300 条 Ozon 任务结果",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  total: 300,
  processed: 300,
  sourceStartRow: 1,
  sourceTotal: 300,
  results,
  logs: [
    {
      time: new Date().toISOString(),
      level: "info",
      message: `合并来源：${sourceSummaries.map((item) => `${item.id}(${item.firstRow}-${item.lastRow}, ${item.count}条)`).join("；")}`,
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

const downloadName = `ozon-1688-merged-300-${new Date().toISOString().slice(0, 10)}.xlsx`;
const downloadPath = path.join(DOWNLOADS_DIR, downloadName);
await fs.copyFile(sourceExcel, downloadPath);

console.log(JSON.stringify({
  outputId: OUTPUT_ID,
  rows: results.length,
  firstRow: results[0]?.sourceRow,
  lastRow: results.at(-1)?.sourceRow,
  sourceExcel,
  downloadPath,
  sources: sourceSummaries,
}, null, 2));
