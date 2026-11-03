import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { createStatisticsAnalysis } from '../lib/statistics-analysis.js';
import { shanghaiDate } from '../lib/ozon-settlement.js';

async function main() {
  const file = process.argv[2];
  if (!file?.startsWith('/opt/ozon/backups/')) throw new Error('Snapshot must be in the private test backup directory');
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!snapshot.days?.length || snapshot.days.at(-1) > shanghaiDate()) throw new Error('Invalid snapshot cutoff');
  const pid = execFileSync('systemctl', ['show', '-p', 'MainPID', '--value', 'ozon-app-test'], { encoding: 'utf8' }).trim();
  const env = Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  if (!env.DATABASE_URL || !new URL(env.DATABASE_URL).pathname.includes('test')) throw new Error('Refusing a non-test database');
  const db = new Pool({ connectionString: env.DATABASE_URL });
  try {
    const store = (await db.query("SELECT id,user_id,client_id FROM app_stores WHERE id=$1 AND active=TRUE AND platform='ozon'", [snapshot.storeId])).rows[0];
    if (!store || String(store.client_id) !== String(snapshot.expectedClientId)) throw new Error('Snapshot store mismatch');
    const analysis = createStatisticsAnalysis({ db, defaultRate: Number(env.RUB_CNY_RATE || 0.0862) });
    await analysis.init();
    const ctx = { userId: store.user_id, storeId: store.id };
    await analysis.importSnapshot(ctx, snapshot);
    const report = analysis.report(await analysis.loadData(ctx), snapshot.month);
    for (const [key, value] of Object.entries(snapshot.expected)) if (report.summary[key] !== value) throw new Error(`Report mismatch: ${key}`);
    console.log(JSON.stringify({ imported: true, summary: report.summary }));
  } finally { await db.end(); }
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
