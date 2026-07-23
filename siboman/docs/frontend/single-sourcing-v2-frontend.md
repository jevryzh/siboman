# Single Sourcing v2 Frontend Notes

## Scope

This frontend pass only touches the single sourcing workbench. It does not change batch upload payloads, listing submission, rich content JSON, stock, warehouse, watermark, or Ozon import-by-sku behavior.

## UX Contract

- Entry remains `#/single-sourcing` as an independent sidebar item.
- The page reads as an operator workbench, not as a tab inside selection center.
- Plugin status shows the current online worker signal only. Historical offline plugin noise belongs in backend diagnostics, not in the main operator card.
- Logs must show time, level, row progress, and stage. The UI keeps the existing formatted log output and makes the log panel full width inside the work area.
- Missing plugin authorization, missing 1688 login, 1688 captcha, empty candidates, and AI provider failure are surfaced as visible operator alerts.
- Candidate display follows the user input `maxCandidates`, defaulting to `5`; it is not hardcoded to `3`.
- Result rows expose Ozon image, candidate image, price, MOQ, freight, weight, AI decision, confidence, reason, and failure status.
- History is a full-width table with persisted Excel download after done, error, or canceled jobs.

## Handoff

Backend and extension owners should make sure result payloads keep these optional frontend fields populated when possible:

- Ozon: `ozon.title`, `ozon.sku`, `ozon.productId`, `ozon.mainImage.publicUrl`, `ozon.mainImageUrl`
- Candidate: `rank`, `title`, `link`, `image`, `imageUrl`, `picUrl`, `price`, `priceDetails`, `moqText`, `minOrderText`, `minOrderQuantity`, `freightText`, `shippingFeeText`, `weightText`, `weightGram`
- AI review: `decision`, `selected_rank`, `confidence`, `reason`, `candidate_reviews[].rank`, `candidate_reviews[].verdict`, `candidate_reviews[].confidence`, `candidate_reviews[].reason`

## Test Notes

Local structural guard: `node tests/test_operations_modules.cjs`.

Full local ERP guard: `npm run test:erp`.

Live acceptance still needs a test-environment run with a logged-in 1688 Chrome session. Local guard does not scrape Ozon/1688 and does not call AI providers.
