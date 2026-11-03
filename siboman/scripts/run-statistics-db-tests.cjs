const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const pid = execFileSync('systemctl', ['show', '-p', 'MainPID', '--value', 'ozon-app-test'], { encoding: 'utf8' }).trim();
  const env = Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map((line) => {
    const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
  }));
  if (!env.DATABASE_URL || !new URL(env.DATABASE_URL).pathname.includes('test')) throw new Error('Refusing a non-test database');
  process.env.STATISTICS_TEST_DATABASE_URL = env.DATABASE_URL;
  await import(pathToFileURL(path.resolve(__dirname, '../tests/test_statistics_database.mjs')).href);
}
main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
