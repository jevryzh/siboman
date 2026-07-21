# /api/v1 Compatibility Plan

Date: 2026-07-21

Scope: P0-A backend contract guardrails for the current `server.js` monolith. This plan does not migrate all legacy routes. It defines how `/api/seller/*` stays compatible while new work moves to `/api/v1`.

## Current Decision

- Keep existing `/api/seller/*` routes active for the current web UI and Chrome extension.
- Add `/api/v1` routes only where the contract is security-critical or low-risk to alias.
- New frontend, extension, and QA work should target `/api/v1` first.
- Legacy response bodies remain unchanged unless an additive field is safe.

## Active Compatibility Layer

| Contract Route | Current Backing Route | Status | Notes |
|---|---|---|---|
| `POST /api/v1/plugin/tokens` | new backend route | active | Issues short scoped worker tokens. Replaces direct seller credential handoff. |
| `GET /api/v1/ai/images/providers` | new backend route | active | Shows configured provider order without exposing keys. |
| `POST /api/v1/ai/images/generate` | `/api/seller/images/generate` handler | active alias | Same payload and response as the legacy route for now. |
| `GET /api/v1/listings/status-contract` | backend status helpers | active | Publishes canonical listing status enum and legacy mapping. |

## Legacy Route Mapping

| Legacy Route | Future Route | Migration Notes |
|---|---|---|
| `GET /api/seller/shops` | `GET /api/v1/stores` | Add envelope and pagination later; legacy route now returns `client_id_masked` / `client_id_last4`, not raw `client_id` or `api_key`. |
| `POST /api/seller/shops` | `POST /api/v1/stores` | Sensitive Ozon keys stay server-side only; response is serialized through the same safe store contract. |
| `GET /api/extension/seller-credentials` | `POST /api/v1/plugin/tokens` | Deprecated. Kept default-open behind `ALLOW_LEGACY_EXTENSION_SELLER_CREDENTIALS` for current plugin compatibility. |
| `POST /api/collect-items` | `POST /api/v1/collector/ozon-items` | Keep payload shape until extension migration is verified. |
| `POST /api/seller/products/import` | `POST /api/v1/listings/batches` | Do not change current batch upload payload shape in this phase. |
| `GET /api/seller/listing-history` | `GET /api/v1/listings/batches` | Legacy route now returns additive `status_canonical` and `status_display`. |
| `POST /api/seller/import/sync-task` | `POST /api/v1/listings/batches/:batchId/sync` | Keep Ozon `task_id` and raw errors visible. |
| `POST /api/seller/images/generate` | `POST /api/v1/ai/images/generate` | Alias is active. Default provider is Agnes. |
| `GET /api/ai-images/history` | `GET /api/v1/ai/images/history` | Pending alias. |

## Response Envelope Plan

New `/api/v1` routes should return `{ success, code, data, requestId, timestamp }`.

Legacy routes may keep `{ success, items, ... }` until each UI surface is migrated. Do not silently wrap legacy responses; that would break current views.

## Listing Status Contract

Canonical enum: `queued`, `claimed`, `running`, `ozon_processing`, `partial_success`, `success`, `failed`, `cancelled`.

Legacy storage is preserved:

| Legacy Value | Canonical Value |
|---|---|
| `pending`, `processing`, `moderating` | `ozon_processing` |
| `imported`, `done` | `success` |
| `error` | `failed` |
| `canceled` | `cancelled` |
| `partial_success = true` | `partial_success` |

## Rollout Steps

1. Extension migrates from `/api/extension/seller-credentials` to `/api/v1/plugin/tokens`.
2. Frontend reads `client_id_masked` / `client_id_last4` for store display and `status_canonical` for filters and badges, while keeping legacy fallback where needed.
3. QA adds regression coverage for `/api/v1` aliases and legacy route compatibility.
4. DevOps sets `ALLOW_LEGACY_EXTENSION_SELLER_CREDENTIALS=false` only after the extension package and zip are verified in test.
5. Backend can then add `/api/v1/stores`, `/api/v1/collector/ozon-items`, and `/api/v1/listings/batches` aliases module by module.
