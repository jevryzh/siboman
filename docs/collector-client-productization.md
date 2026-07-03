# Collector Client Productization

## Decision

Do not distribute PowerShell, shell, or command-line startup scripts to ERP customers.

The commercial product should first provide a browser extension collector:

- Chrome/Edge extension
- Login with ERP account credentials
- Reuses the customer's own browser session for Ozon and 1688
- Lets the customer handle verification in their visible browser
- Reports heartbeat to `/api/worker/status`

For heavy users, a packaged desktop collector can be added later:

- Windows installer or portable desktop app
- macOS app when needed
- Login with ERP account credentials
- Shows connection, browser, and current-task status
- Starts automatically or remains in tray while collecting
- Uses a private browser profile per local user
- Reports heartbeat to `/api/worker/status`

## Why

The collector operates on the customer's own computer because Ozon and 1688 sessions, verification windows, and browsing behavior must stay local. However, asking customers to run scripts is not an acceptable product experience and is hard to support at scale.

A browser extension is the lightest commercial packaging path because it avoids a desktop installer and can reuse the customer's logged-in browser state.

## Current Server Contract

The server already supports productized clients through these endpoints:

- `POST /api/auth/login`
- `POST /api/worker/jobs/next`
- `POST /api/worker/jobs/:id/progress`
- `POST /api/worker/jobs/:id/complete`
- `GET /api/worker/status`

The client should send `workerName`, `platform`, `hostname`, and `profileDir` with each worker request so the ERP page can display online status.

## Implementation Direction

Build the collector as a browser extension first. The UI should hide environment variables and command-line details from the customer.

Suggested packaging path:

1. Add extension token login and heartbeat.
2. Show extension online status in the ERP page.
3. Migrate Ozon product page collection into extension content scripts.
4. Migrate 1688 image search into extension-controlled tabs.
5. Enable automatic task claiming only after one full job can complete reliably.
6. Publish through Chrome Web Store or enterprise/private extension distribution.
