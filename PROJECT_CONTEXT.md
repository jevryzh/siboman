# Ozon -> 1688 Sourcing Tool Project Context

Last updated: 2026-07-02 Asia/Shanghai

Read this file first when opening a new Codex / MiniMax / Claude Code / VS Code AI session. It is the handoff document for this project.

## 0. One-Sentence Summary

This project is a private Ozon -> 1688 sourcing system. Users paste Ozon product links into a web UI. A server stores login, task queues, history, and downloadable Excel files. Real scraping is performed by collector programs running on the user's own computers, because Ozon and 1688 should be accessed from the user's local browser/IP/account instead of from the server.

## 1. Current Goal

The system should:

1. Accept many Ozon links.
2. Scrape Ozon product title, images, product attributes, black price in RMB, seller count, and weight when available.
3. Use Ozon main image to search 1688 for supply candidates.
4. Scrape 1688 candidate details: MOQ, price, shipping fee, dimensions if available, weight if available.
5. Use MiniMax AI to strictly review whether candidate products match the Ozon product.
6. Return one best result per Ozon product.
7. If exact match is not found, return a closest approximate candidate and mark the row yellow.
8. Export Excel with embedded Ozon and 1688 images side by side.
9. Add a logistics calculation sheet based on the provided template.
10. Store history and allow re-download from the server UI.
11. Support multiple users/co-workers without mixing their task history.

## 2. Important Product Rules

These rules are user requirements and should not be casually changed.

### 2.1 Matching Rules

- AI should first judge whether the 1688 product is exactly the same as the Ozon product.
- If not exact, do not randomly select a product.
- If no exact match exists, return a closest approximate candidate and mark the row yellow for manual review.
- Procurement price, promotion price, shipping price, weight, and dimensions are data fields. They should not be used as strict product identity criteria by themselves.
- Ozon / 1688 weights and dimensions may be inaccurate. Do not require them to match.
- If Ozon title or image indicates multiple pieces are sold together, 1688 purchase price should be estimated by multiplying the single supply price according to quantity.
- Watermarks added by Ozon sellers, such as MAOLA in product images, are not automatically brand identifiers. AI should consider they may be seller watermarks.

### 2.2 1688 Price Rules

- `1688价格` should be the single-piece purchase price for the applicable MOQ tier, not the lowest high-volume tier.
- Example: if the price text is `2件起 ¥2.59; 10件起 ¥2.57; 50件起 ¥2.55`, the displayed single purchase price should be `2.59`, not `2.57`.
- Keep the detailed tier text in `1688价格明细`.
- Exclude misleading traffic-bait prices and promotions when choosing the best supply source:
  - Extremely low prices like cents or a few mao that do not match actual product pricing.
  - First-order discount, new-user price, first-order minus 1 RMB, or similar one-time promotional prices.
- Promotion/traffic risk should be recorded, but price should not be used as the sole reason to reject product identity.

### 2.3 Ozon RMB Black Price Rules

The browser must be set to Chinese language and CNY/RMB currency on Ozon buyer side.

Final field: `Ozon产品黑标价RMB`.

Rule:

1. Current product black price = the black price line below the green price on the current product page.
2. Low-price recommendation black price = the black price visible in the external low-price recommendation block, such as `低价推荐` / Russian equivalent.
3. Do not open the low-price recommendation detail page.
4. Final `Ozon产品黑标价RMB` is the minimum of these two visible black prices.
5. If there is no low-price recommendation, use the current product black price.
6. If the product is unavailable / delisted and the page has no data, skip it and do not continue to 1688 search.

Fields that were intentionally removed or should not be re-added unless requested:

- `Ozon跟卖最低黑标价RMB`
- `Ozon产品黑标价数值`
- `Ozon跟卖最低黑标价数值`
- `最低价格RMB`
- `最高价格RMB`
- `1688店铺`
- `品牌`
- `币种`

### 2.4 Ozon Weight Rules

- Keep `Ozon重量（克）`, unit is grams.
- Do not use MYERP widget weight as Ozon weight.
- Ozon product page often hides or does not expose weight reliably.
- If Ozon page weight cannot be found, leave `Ozon重量（克）` blank.
- Add `AI估算重量（克）` in the logistics sheet after `重量（克）`.
- AI estimates product weight from product title, attributes, images, dimensions, and category. It is only an estimate and should be reviewable.

### 2.5 1688 Weight / Shipping / Dimensions Rules

- Keep `1688重量（克）`, unit is grams.
- Keep `1688运费`.
- Keep `1688尺寸`.
- If not available, leave blank.
- There was a previous bug: `normalizeWeightGrams is not defined` inside page.evaluate. That was fixed earlier. Avoid reintroducing browser-evaluate references to outer-scope functions unless injected explicitly.

### 2.6 Anti-Bot / Human-Like Browsing Rules

- Ozon and 1688 are sensitive to frequent repeated access.
- Use randomized delays between products.
- Use human-like browsing:
  - Move mouse.
  - Scroll down gradually.
  - Use variable scroll frequency.
  - Dwell on detail pages.
  - Scroll back to top before closing detail page.
- If verification / slider captcha appears:
  - Notify user.
  - Wait for user to solve it.
  - Do not keep blindly running hundreds of rows.
- If critical errors continue or captcha/login/IP restrictions occur, stop task instead of wasting resources.

## 3. Architecture

### 3.1 Components

1. Server web app
   - File: `server.js`
   - Runs on cloud server.
   - Provides web UI, login, task queue, history, downloads.
   - Uses PostgreSQL when `DATABASE_URL` is set.
   - Does not scrape when `DISABLE_SERVER_SCRAPER=true`.

2. Frontend
   - Files:
     - `public/index.html`
     - `public/app.js`
     - `public/styles.css`
   - Users paste links, create jobs, view progress/history/downloads.

3. Local collector
   - File: `collector.js`
   - Runs on user or co-worker computer.
   - Logs into server using a normal web account.
   - Polls for that user's queued jobs.
   - Runs Playwright locally to scrape Ozon and 1688.
   - Uploads final job JSON and Excel back to server.

4. Browser extension reference
   - Folder: `browser-extension/`
   - Historical/reference material from the panda listing package.
   - Not core runtime for current Node server/collector system.

5. Logistics template
   - File: `data/templates/logistics-template.xlsx`
   - Used by Excel export to add the logistics calculation sheet.
   - This is intentionally tracked in Git even though other `data/` files are ignored.

### 3.2 Server vs Collector Responsibilities

Server:

- User login.
- Multi-user accounts.
- PostgreSQL task queue.
- History list.
- Download route.
- Receives collector progress.
- Receives final Excel.
- Does not directly open Ozon or 1688 in server mode.

Collector:

- Runs on local Mac / co-worker computer.
- Opens local browser.
- Uses local network/IP and local login sessions.
- Scrapes Ozon and 1688.
- Handles captcha prompts locally.
- Generates Excel locally.
- Uploads complete result back to server.

This split is important. The server should not scrape Ozon/1688 because:

- It does not have the user's logged-in 1688/Ozon browser session.
- Server IP may be more easily risk-controlled.
- User wanted collection to happen on their own/co-workers' computers.

## 4. Current Deployment

### 4.1 Public URL

- Main URL: `http://xm.renwz.cn`
- Domain: `renwz.cn`
- Subdomain: `xm`
- Public server IP: `47.104.86.62`
- HTTP only at the moment. Browser shows "not secure". HTTPS is not configured yet.

### 4.2 Remote Server

- OS: Ubuntu on Alibaba Cloud.
- SSH user: `root`
- SSH key on local Mac: `~/.ssh/ozon_deploy_ed25519`
- App directory: `/opt/ozon/app`
- systemd service: `ozon-app`
- Nginx reverse proxy: `/etc/nginx/sites-available/ozon-app`
- Nginx proxies `xm.renwz.cn` to `http://127.0.0.1:5177`.
- Server process listens on `127.0.0.1:5177`.

Useful remote commands:

```bash
ssh -i ~/.ssh/ozon_deploy_ed25519 root@47.104.86.62
systemctl status ozon-app --no-pager
journalctl -u ozon-app -n 120 --no-pager
cd /opt/ozon/app
```

Restart server:

```bash
ssh -i ~/.ssh/ozon_deploy_ed25519 root@47.104.86.62 'systemctl restart ozon-app && sleep 2 && systemctl is-active ozon-app'
```

### 4.3 PostgreSQL

- Database: `ozon_sourcing`
- App DB user: `ozon_app`
- DB password is intentionally not written here. It is in the remote `.env`.
- PostgreSQL is localhost-only.

Tables:

- `app_users`
  - id, username, password_hash, display_name, role, active, created_at, updated_at, last_login_at.
- `app_jobs`
  - id, user_id, kind, status, phase, total, processed, source_total, source_start_row, payload, logs, results, error, download_url, created_at, updated_at, last_downloaded_at.

Useful DB inspection command:

```bash
ssh -i ~/.ssh/ozon_deploy_ed25519 root@47.104.86.62 \
  'sudo -u postgres psql -d ozon_sourcing -c "SELECT status, kind, count(*) FROM app_jobs GROUP BY status, kind ORDER BY status, kind;"'
```

### 4.4 Current Accounts

Existing known usernames:

- `eason` - admin
- `partner` - normal user

Do not put passwords in Git. Passwords are in the private deployment notes / `.env` / user memory. If an AI agent needs to test login, ask the user for the password or use an existing authenticated browser session.

Important:

- `INITIAL_USERS` in remote `.env` only seeds accounts if they do not already exist.
- Changing `INITIAL_USERS` will not reset passwords for existing rows.
- Future requirement: add account creation / management UI.

## 5. Local Machine State

Local project directory:

```bash
/Users/eason/Documents/OZON
```

Local `.env` exists but is ignored by Git. It currently contains secrets such as MiniMax key and collector login values.

Local collector is run using `screen`:

```bash
screen -dmS ozon-collector /bin/zsh -lc 'cd /Users/eason/Documents/OZON && exec /opt/homebrew/bin/node collector.js >> data/collector.log 2>> data/collector-error.log'
```

Check collector:

```bash
cd /Users/eason/Documents/OZON
screen -ls
tail -f data/collector.log
tail -f data/collector-error.log
```

Stop collector:

```bash
screen -S ozon-collector -X quit
```

If Playwright browser profile is stuck:

```bash
ps aux | rg 'collector.js|data/browser-profile|Google Chrome for Testing' | rg -v rg
pkill -f 'data/browser-profile'
screen -S ozon-collector -X quit
```

Then restart collector.

## 6. Environment Variables

Use `.env.example` as a template.

Important server variables:

- `PORT=5177`
- `HOST=127.0.0.1`
- `DATABASE_URL=postgresql://...`
- `DISABLE_SERVER_SCRAPER=true`
- `APP_PASSWORD` only used in legacy no-DB mode.
- `AUTH_SECRET` signs login cookie.
- `INITIAL_USERS` seeds first users.

Important MiniMax variables:

- `MINIMAX_API_KEY`
- `MINIMAX_BASE_URL=https://api.minimaxi.com/v1`
- `MINIMAX_MODEL=MiniMax-M3`
- `MINIMAX_THINKING_TYPE=disabled` currently preferred after deep-thinking caused slow/failure concerns.
- `AI_CONFIDENCE_THRESHOLD=0.78`
- `MINIMAX_INPUT_USD_PER_M=0.30`
- `MINIMAX_OUTPUT_USD_PER_M=1.20`

Important collector variables:

- `COLLECTOR_SERVER_URL=http://xm.renwz.cn`
- `COLLECTOR_USERNAME`
- `COLLECTOR_PASSWORD`
- `COLLECTOR_WORKER_NAME`
- `COLLECTOR_POLL_SECONDS=5`
- `COLLECTOR_PROGRESS_SECONDS=4`

## 7. Code Map

### 7.1 `server.js`

Major responsibilities:

- Load `.env`.
- Express server.
- Login/auth cookie.
- PostgreSQL setup and multi-user auth.
- Web job creation.
- Worker/collector queue endpoints.
- Ozon scraping.
- 1688 image search and detail scraping.
- MiniMax AI review.
- Excel export with embedded images and logistics sheet.

Important API routes:

- `GET /login`
- `GET /api/auth/status`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `POST /api/1688/open`
  - In server queue mode, this returns success with a disabled message. It should not error with "禁止采集".
- `POST /api/browser/close`
  - In server queue mode, browser is managed by local collector.
- `POST /api/jobs`
  - Create Ozon -> 1688 sourcing job.
  - In server queue mode, inserts queued DB job and returns `{ queued: true }`.
- `POST /api/batch-ozon/jobs`
  - Create Ozon discovery/filtering batch job.
- `GET /api/jobs/:id`
  - Get job status.
- `POST /api/jobs/:id/cancel`
  - Cancel job. Collector sees canceled status on next progress sync and stops after current item.
- `GET /api/history`
  - History/statistics.
- `GET /api/history/:id/download`
  - Download Excel.
- `POST /api/worker/jobs/next`
  - Collector claims next queued job for current user.
- `POST /api/worker/jobs/:id/progress`
  - Collector uploads progress.
- `POST /api/worker/jobs/:id/complete`
  - Collector uploads final job and Excel.

Important functions:

- `initDatabase()`
- `seedInitialUsers()`
- `claimNextDbJob()`
- `normalizeWorkerJobUpdate()`
- `saveWorkerArtifacts()`
- `runJob()`
- `runBatchOzonJob()`
- `scrapeOzonProduct()`
- `ensureOzonChineseCny()`
- `search1688ByImage()`
- `humanBrowse1688DetailPage()`
- `reviewCandidatesWithMiniMax()`
- `applyAiReview()`
- `writeJobArtifacts()`
- `writeBatchOzonArtifacts()`
- `writeXlsxWithEmbeddedImages()`

### 7.2 `collector.js`

Purpose:

- Login to server.
- Poll `/api/worker/jobs/next`.
- Run local scraping with existing server.js runtime functions.
- Sync progress every few seconds.
- Upload final Excel to server.

Behavior:

- Requires `COLLECTOR_USERNAME` and `COLLECTOR_PASSWORD`.
- Uses the same account as the web UI. A normal user only claims their own jobs.
- Retries login/worker polling if network/server temporarily fails.
- Writes logs to stdout; production launch redirects to `data/collector.log`.

### 7.3 Frontend Files

- `public/index.html`
  - Main layout.
- `public/app.js`
  - Job creation, polling, history, download, queue-mode UI.
  - In collector/server mode, "Open 1688" button changes to local collector messaging.
- `public/styles.css`
  - UI styling.

### 7.4 Scripts

Historical merge/refresh scripts live in `scripts/`.

Examples:

- `scripts/merge-ozon-100-2026-06-29.mjs`
- `scripts/merge-ozon-300.mjs`
- `scripts/merge-provided-100-2026-06-30.mjs`
- `scripts/refresh-provided-100-ozon-cny.mjs`
- `scripts/start-collector.sh`

These scripts may be one-off utilities. Review before reusing.

## 8. Excel Export Rules

Main sheet: `Ozon-1688`.

Important fields:

- Ozon and 1688 images embedded in sheet, side by side.
- Ozon title, URL, image, black price RMB, seller count, weight grams.
- 1688 title, URL, image, MOQ, price, price detail, shipping, dimensions, weight grams.
- AI match result, confidence, reason, token usage, estimated cost.
- Yellow highlight for approximate / no exact match rows.
- `盈亏` and `利润率` should also appear in Ozon-1688 before Ozon price and match the logistics sheet result.

Logistics sheet:

- Based on `data/templates/logistics-template.xlsx`.
- Green columns are user-fill columns and must retain original formatting/formulas.
- Fill rules:
  - `SkuId`: Ozon product ID.
  - `重量（克）`: prefer Ozon weight grams if available.
  - `AI估算重量（克）`: AI estimated weight.
  - `黑标价`: `Ozon产品黑标价RMB`.
  - `阿里巴巴采购价(预)`: `1688价格 + 1688运费`.

## 9. AI / MiniMax Integration

MiniMax is used inside the app runtime for:

- Product match review.
- Weight estimation.
- Token/cost recording.

Current model:

- `MiniMax-M3`

Current thinking mode:

- `disabled`

Reason:

- User tested deep thinking and felt speed/failure rate was worse.
- Keep disabled unless specifically requested.

MiniMax API Key:

- Stored in local `.env` and remote `.env`.
- Never commit key.
- Never print key in chat or logs.

Codex itself:

- The user configured Codex to optionally use MiniMax-M3 as a model provider.
- Current config files:
  - `~/.codex/config-profiles/openai.toml`
  - `~/.codex/config-profiles/minimax.toml`
  - `~/.codex/model-catalogs/custom-catalog.json`
- Switch commands:

```bash
~/.codex/switch-to-openai.sh
~/.codex/switch-to-minimax.sh
```

After switching, restart Codex. Old conversation context does not automatically carry over. That is why this file exists.

## 10. Deployment Workflow

From local Mac:

```bash
cd /Users/eason/Documents/OZON
node --check server.js
node --check collector.js
node --check public/app.js

rsync -az -e 'ssh -i ~/.ssh/ozon_deploy_ed25519 -o BatchMode=yes' \
  server.js collector.js package.json package-lock.json README.md PROJECT_CONTEXT.md \
  root@47.104.86.62:/opt/ozon/app/

rsync -az -e 'ssh -i ~/.ssh/ozon_deploy_ed25519 -o BatchMode=yes' \
  public/ root@47.104.86.62:/opt/ozon/app/public/

ssh -i ~/.ssh/ozon_deploy_ed25519 -o BatchMode=yes root@47.104.86.62 '
  cd /opt/ozon/app
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev
  node --check server.js
  node --check collector.js
  node --check public/app.js
  chown -R ozon:ozon /opt/ozon/app
  systemctl restart ozon-app
  sleep 2
  systemctl is-active ozon-app
'
```

Do not sync `.env`, `data/jobs`, or browser profiles.

## 11. Common Problems and Fixes

### 11.1 "服务器端已禁用本机浏览器采集" / "禁止采集"

Expected behavior:

- Server mode should not directly open browser.
- `POST /api/1688/open` should return success with a friendly message saying local collector handles browser.

If user sees old forbidden message:

1. Hard refresh browser: `Cmd + Shift + R`.
2. Confirm server has updated `public/app.js`.
3. Confirm `POST /api/1688/open` returns JSON with `success: true` and `disabled: true`.

Test:

```bash
curl -sS -c /tmp/ozon_cookie \
  -H 'Content-Type: application/json' \
  -d '{"username":"eason","password":"ASK_USER"}' \
  http://xm.renwz.cn/api/auth/login

curl -sS -b /tmp/ozon_cookie \
  -H 'Content-Type: application/json' \
  -d '{}' \
  http://xm.renwz.cn/api/1688/open
```

### 11.2 Collector Does Not Claim Jobs

Check:

```bash
screen -ls
tail -80 data/collector.log
tail -80 data/collector-error.log
```

Check remote DB:

```bash
ssh -i ~/.ssh/ozon_deploy_ed25519 root@47.104.86.62 \
  'sudo -u postgres psql -d ozon_sourcing -c "SELECT id, user_id, status, phase, kind, total, processed, updated_at FROM app_jobs ORDER BY created_at DESC LIMIT 10;"'
```

Possible causes:

- Collector is logged in as a different user than the job owner.
- Collector password wrong.
- Server URL wrong.
- Server unreachable.
- Collector process stopped.

### 11.3 Playwright Browser Profile Occupied

Error example:

`browserType.launchPersistentContext: Target page, context or browser has been closed`

Browser log may say:

`正在现有的浏览器会话中打开。`

Cause:

- Old Chrome for Testing still owns `data/browser-profile`.
- Duplicate collector processes are running.

Fix:

```bash
cd /Users/eason/Documents/OZON
screen -S ozon-collector -X quit 2>/dev/null || true
pkill -f 'data/browser-profile' 2>/dev/null || true
pkill -f '/opt/homebrew/bin/node collector.js' 2>/dev/null || true
sleep 1
ps aux | rg 'collector.js|data/browser-profile|Google Chrome for Testing' | rg -v rg
screen -dmS ozon-collector /bin/zsh -lc 'cd /Users/eason/Documents/OZON && exec /opt/homebrew/bin/node collector.js >> data/collector.log 2>> data/collector-error.log'
```

### 11.4 Captcha / Verification

Expected:

- The system should notify user and wait.
- User solves captcha in the browser window.
- Task should continue after verification.

If it keeps saying verification is not solved:

- There may be multiple browser windows or wrong browser profile.
- Close old collector/browser and restart one clean collector.
- Do not run multiple collectors on same computer using same profile.

### 11.5 Server Down

Check:

```bash
ssh -i ~/.ssh/ozon_deploy_ed25519 root@47.104.86.62 'systemctl status ozon-app --no-pager'
ssh -i ~/.ssh/ozon_deploy_ed25519 root@47.104.86.62 'journalctl -u ozon-app -n 120 --no-pager'
```

Restart:

```bash
ssh -i ~/.ssh/ozon_deploy_ed25519 root@47.104.86.62 'systemctl restart ozon-app'
```

### 11.6 Static Frontend Seems Old

- Browser may cache JS.
- Use `Cmd + Shift + R`.
- If still old, check server file:

```bash
ssh -i ~/.ssh/ozon_deploy_ed25519 root@47.104.86.62 \
  'cd /opt/ozon/app && grep -n "本机采集端已接管\\|collectorMode" public/app.js'
```

## 12. Git / Security Notes

Never commit:

- `.env`
- API keys
- DB passwords
- user login passwords
- `data/jobs/`
- `data/browser-profile/`
- `data/ozon-refresh-profile/`
- `node_modules/`
- logs

Tracked intentionally:

- Source files.
- Public UI files.
- Package files.
- `.env.example`.
- `PROJECT_CONTEXT.md`.
- `data/templates/logistics-template.xlsx`.
- Browser extension reference files.

Before committing, always run:

```bash
rg -n "sk-|MINIMAX_API_KEY|DATABASE_URL|APP_PASSWORD|AUTH_SECRET|COLLECTOR_PASSWORD|experimental_bearer_token" \
  --glob '!node_modules/**' --glob '!data/jobs/**' --glob '!data/browser-profile/**' --glob '!.env' .
```

This command may find variable names in source code; that is OK. It should not find real secret values.

## 13. How To Start New AI Session

For MiniMax / new Codex / Claude Code:

1. Open project directory:

```bash
cd /Users/eason/Documents/OZON
```

2. Tell the AI:

```text
请先读取 /Users/eason/Documents/OZON/PROJECT_CONTEXT.md，然后继续这个 Ozon-1688 项目。不要读取或输出 .env 里的密钥。
```

3. Ask it to inspect current status:

```bash
git status --short
screen -ls
tail -40 data/collector.log
ssh -i ~/.ssh/ozon_deploy_ed25519 root@47.104.86.62 'systemctl is-active ozon-app'
```

## 14. Recommended Next Tasks

High priority:

1. Add account creation / account management UI.
2. Add HTTPS for `xm.renwz.cn`.
3. Add collector registration/status page so server can show which user computers are online.
4. Prevent two collectors with same user/profile from running on one computer.
5. Improve captcha handling UX so user sees a clear pop-up and browser window reference.
6. Add resumable queued jobs from failed row.
7. Add role permissions: admin sees all jobs, user sees own jobs only.

Medium priority:

1. Move large Excel upload from JSON base64 to multipart upload.
2. Add task result cleanup/retention rules.
3. Add provider abstraction for AI models.
4. Add per-user MiniMax token/cost tracking.
5. Add automated tests for price parsing, Ozon black price extraction, and 1688 tier price parsing.

Low priority:

1. Better UI polish.
2. Export custom column selection.
3. Add CSV export.
4. Add product-category-specific AI prompts.

## 15. Current Mental Model

If something goes wrong, ask:

1. Is it a server queue/login/history problem?
   - Check `ozon-app`, PostgreSQL, API routes.
2. Is it a local collector problem?
   - Check `screen`, collector logs, browser profile.
3. Is it a scraping rule problem?
   - Check `scrapeOzonProduct`, `search1688ByImage`, and extraction logic.
4. Is it an AI choice problem?
   - Check `reviewCandidatesWithMiniMax`, prompts, thresholds, token usage.
5. Is it an Excel export problem?
   - Check `writeJobArtifacts`, `writeXlsxWithEmbeddedImages`, logistics template mapping.

This project is stateful and operational. Do not make large refactors casually. Keep fixes targeted and preserve user data.
