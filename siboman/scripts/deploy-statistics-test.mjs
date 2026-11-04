import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';

const app = '/opt/ozon/app-test';
const stage = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const backup = path.resolve(stage, '../original');
const baseline = {
  'server.js': 'a5121c73591912843925dba12c5d8d1cea7a8ad9b1602cbb48fd9ee2cc65e552',
  'public/js/main.js': '12b10e4744eabaecb9b8873e23fd53bc54964aa1de1e7dbcbce273b7b8e0f2cf',
  'public/index.html': 'db6b2f54f26db632571ab3099f677bddc0a8cf4cbbd21b0074fc55a31f63562d',
  'package.json': '4b055bf62460ceda78ac905a173a6a25e97edef77d6c3ce8a2ca891ff7fa0244',
};
const files = [...Object.keys(baseline), 'lib/ozon-settlement.js', 'lib/statistics-analysis.js',
  'public/js/views/StatisticsAnalysis.js', 'public/statistics-analysis.css', 'tests/test_statistics_analysis.mjs',
  'tests/test_statistics_database.mjs', 'scripts/run-statistics-db-tests.cjs', 'docs/statistics-analysis.md'];
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function assertBaseline() {
  for (const file of files) {
    const target = path.join(app, file);
    if (baseline[file] ? (!fs.existsSync(target) || sha(target) !== baseline[file]) : fs.existsSync(target)) throw new Error(`Test server changed since baseline: ${file}`);
  }
}
async function main() {
  if (!stage.startsWith('/opt/ozon/backups/test-statistics-') || fs.existsSync(backup)) throw new Error('Refusing an unexpected or reused deployment directory');
  const pid = execFileSync('systemctl', ['show', '-p', 'MainPID', '--value', 'ozon-app-test'], { encoding: 'utf8' }).trim();
  const env = Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  if (!env.DATABASE_URL || !new URL(env.DATABASE_URL).pathname.includes('test')) throw new Error('Refusing a non-test database');
  assertBaseline();
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    const jobs = (await pool.query("SELECT kind,status,count(*) AS count FROM app_jobs WHERE status IN ('running','processing') GROUP BY kind,status")).rows;
    if (jobs.length) throw new Error('Active business jobs; postpone restart: ' + JSON.stringify(jobs));
    fs.mkdirSync(backup, { recursive: true });
    for (const file of Object.keys(baseline)) { const destination = path.join(backup, file); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(path.join(app, file), destination); }
    const exists = (await pool.query("SELECT to_regclass('public.app_statistics_accruals') AS name")).rows[0].name;
    if (exists) execFileSync('pg_dump', ['--format=custom', '--file', path.join(backup, 'statistics-before.dump'), '--table=public.app_statistics_*'], { env: { ...process.env, PGDATABASE: env.DATABASE_URL }, stdio: ['ignore', 'ignore', 'pipe'] });
    fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify({ app, files, baseline, backedUpAt: new Date().toISOString(), databaseTablesExisted: !!exists }, null, 2));
  } finally { await pool.end(); }
  for (const file of ['server.js', 'lib/ozon-settlement.js', 'lib/statistics-analysis.js', 'public/js/main.js', 'public/js/views/StatisticsAnalysis.js']) execFileSync(process.execPath, ['--check', path.join(stage, file)]);
  assertBaseline();
  for (const file of files) {
    const target = path.join(app, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    if (file === 'package.json') {
      const existing = JSON.parse(fs.readFileSync(target));
      existing.scripts['test:statistics'] = JSON.parse(fs.readFileSync(path.join(stage, file))).scripts['test:statistics'];
      fs.writeFileSync(target + '.statistics-new', JSON.stringify(existing, null, 2) + '\n');
    } else fs.copyFileSync(path.join(stage, file), target + '.statistics-new');
    fs.renameSync(target + '.statistics-new', target);
  }
  execFileSync('systemctl', ['restart', 'ozon-app-test']);
  console.log(JSON.stringify({ deployed: true, service: 'ozon-app-test', backup, files: files.length, productionTouched: false }));
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
