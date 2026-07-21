const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/extension/zhumeng-collector/manifest.json'), 'utf8'));
const storeManagement = fs.readFileSync(path.join(root, 'public/js/views/StoreManagement.js'), 'utf8');

function matchVersion(source, pattern, label) {
  const match = source.match(pattern);
  assert(match, `missing ${label}`);
  return match[1];
}

assert(/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version), 'manifest version must be a Chrome-compatible numeric release');
assert.strictEqual(matchVersion(storeManagement, /PLUGIN_MANIFEST_VERSION\s*=\s*['"]([^'"]+)/, 'PLUGIN_MANIFEST_VERSION'), manifest.version);
assert.strictEqual(matchVersion(storeManagement, /PLUGIN_ZIP_VERSION\s*=\s*['"]([^'"]+)/, 'PLUGIN_ZIP_VERSION'), manifest.version);
assert(storeManagement.includes('/extension/zhumeng-collector.zip?v=${PLUGIN_ZIP_VERSION}'));
assert(storeManagement.includes('逐梦 Ozon 采集器'));

childProcess.execFileSync(
  process.execPath,
  [path.join(root, 'scripts/check-extension-release.mjs'), '--quiet'],
  { cwd: root, stdio: 'inherit' }
);

console.log('Extension release consistency structural checks passed.');
