# Test Environment Extension Release Checklist

Scope: local and test environment checks for `zhumeng-collector`. Production is out of scope unless explicitly authorized.

## Local Gate

```bash
npm run test:extension-release
npm run test:erp
git diff --check
```

Confirm:

- `public/extension/zhumeng-collector/manifest.json` version matches `background.js` `VERSION`.
- `public/extension/zhumeng-collector.zip` contains the same files and bytes as `public/extension/zhumeng-collector/`.
- `StoreManagement.js` exposes `PLUGIN_MANIFEST_VERSION` and `PLUGIN_ZIP_VERSION` matching `manifest.version`.
- The plugin download URL is `/extension/zhumeng-collector.zip?v=<manifest.version>`.
- Popup version comes from `chrome.runtime.getManifest()`.

## Test Environment Gate

Use only read-only checks unless the orchestrator explicitly approves more:

```bash
CHECK_REMOTE_TEST=1 npm run test:extension-release
```

Do not deploy production, do not include real credentials in logs, and do not change plugin collection core logic merely for release consistency.
