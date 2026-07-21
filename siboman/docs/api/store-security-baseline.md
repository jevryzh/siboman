# Store Security Baseline

Date: 2026-07-21

Scope: test-environment store management, plugin token handoff, and store-scoped watermark / AI defaults.

## Store Response Contract

`GET /api/seller/shops`, `POST /api/seller/shops`, and `PATCH /api/seller/shops/:id/settings` must not return raw Ozon `client_id` or `api_key`.

Returned store objects use safe display fields:

| Field | Notes |
|---|---|
| `id` | Store UUID. |
| `name` | Store display name. |
| `active` | Whether the store can be used. |
| `client_id_masked` | Masked Ozon Client ID for human recognition only. |
| `client_id_last4` | Last four characters for compact UI tags. |
| `watermark_enabled` | Store default for batch image watermarking. |
| `watermark_text` | Store watermark text, capped server-side. |
| `ai_image_provider` | Store default AI provider preference, currently advisory. |
| `ai_image_model` | Store default AI image model when the request omits `model`. |

The raw Ozon Client ID and API Key stay in `app_stores` and are used only by server-side Ozon calls or the explicitly deprecated compatibility endpoint.

## Isolation Rules

- Store list reads filter by `user_id`.
- Store create/upsert is unique on `(user_id, client_id)`, so two users can save the same Ozon Client ID independently.
- Store settings updates require `WHERE id = $3 AND user_id = $4`.
- Deactivation requires `WHERE id = $1 AND user_id = $2`.
- Plugin token issuance calls `assertActiveStoreAccess(storeId, req.user.id, "id, name")`.
- AI image generation validates `store_id + user_id + active` before reading store AI defaults.

## Plugin Token Contract

`POST /api/v1/plugin/tokens` returns a short-lived bearer token:

```json
{
  "success": true,
  "code": "OK",
  "data": {
    "token": "scoped...",
    "tokenType": "Bearer",
    "expiresIn": 900,
    "scope": ["collector:submit", "worker:poll"],
    "storeId": "store-uuid",
    "storeName": "Demo Store"
  }
}
```

The response uses `Cache-Control: no-store` and must not include Ozon `client_id`, `clientId`, `api_key`, or `apiKey`.

Scoped plugin tokens are not full ERP session tokens. They can access only:

| Scope | Allowed server paths |
|---|---|
| `collector:submit` | `POST /api/collect-items`, with `store_id` forced to the token store. |
| `worker:poll` | Worker queue/status/progress paths under `/api/worker/*`, excluding `/api/worker/plugin-token`. |

Worker job claims and job lookups are filtered by `user_id` and the token `storeId`.

## Legacy Credential Route

`GET /api/extension/seller-credentials` is deprecated and exists only for compatibility while the Chrome extension migrates.

- Current test-env stance: legacy route remains default-open compatibility window because the current extension still calls it for OPI enrichment.
- Kill switch: set `ALLOW_LEGACY_EXTENSION_SELLER_CREDENTIALS=false` only after plugin migration and batch upload regression pass.
- Replacement: `POST /api/v1/plugin/tokens`.
- Logging: only masked Client ID is logged.

## Frontend Compatibility

`StoreManagement.js` and `ShopSwitcher.js` must prefer `client_id_masked` / `client_id_last4` and keep a fallback to local masking of legacy `client_id`.
