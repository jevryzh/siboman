# P1-3-BUG-02/03 Local Fixture Contracts

These tests are local-only guards. They do not deploy, call AI providers, call Ozon, or require a collector login.

## P1-3-BUG-02 Collection Box Duplicates

Executable coverage:

- `tests/test_collection_box.cjs`
- `tests/fixtures/collection_duplicate_contract.json`

Contract locked by the fixture:

- Ozon URLs and plain numeric SKU inputs must normalize to the same `ozonSku` when the URL contains a product id.
- Manual duplicate links/SKUs are skipped or restored by the existing row lookup instead of creating duplicate work.
- Extension duplicate payloads update an existing non-uploaded row, mark it as `scraped`, append a merge status log, and report the row as skipped with an existing merge reason.
- Already uploaded rows are reported as skipped and must not be overwritten by duplicate collector payloads.

Because `server.js` is not currently structured as an importable test module, the test extracts `parseCollectInputs` for fixture parsing and uses route/SQL structure guards for merge behavior.

## P1-3-BUG-03 AI JSON Cleanup

Executable coverage:

- `tests/test_ai_image_generator.cjs`
- `tests/fixtures/ai_json_cleanup_contract.json`

Contract locked by the fixture:

- `<think>...</think>` blocks are stripped before JSON parsing.
- Markdown code fences are stripped before JSON parsing.
- Prefix/suffix text around a JSON object is tolerated.
- Incomplete JSON returns `null`, then the `/api/ai/analyze` route must repair once or return a structured 502 instead of passing malformed data onward.
- Parsed AI output is normalized into the expected product-text structure before entering product or listing workflows.
