# Luna evaluation results — 2026-09-14

Model: `gpt-5.6-luna`, high reasoning. Live evaluations use the shared tool
definitions, real SDK/Pyodide execution, and synthetic IFC data. There is no
extra evaluation system prompt, model judge, or Python repair wrapper.

| Run | Cases passing all checks | Failed Python executions |
| --- | ---: | ---: |
| Original guidance, initial 13 cases | 8/13 | 3 |
| Final full run, expanded to 20 cases | 17/20 | 0 |
| Final edge-case rechecks, two filenames each | 4/6 | 0 |

All six final rechecks produced correct outcomes. Both failures are the same
efficiency issue: coloring with missing dimensions takes three Python calls,
exceeding the two-call budget. The budget remains unchanged. Ordinary coloring
and missing-dimension quantities passed both repeats with two Python calls.
Across the full run and rechecks, all 20 scenarios have a verified correct
outcome, but the strict live suite is **not fully green**.

The full run also encountered an API connection reset in color-by-size;
both final rechecks passed. Its missing-dimension quantity assertion originally
required a missing-value explanation even when geometry supplied the correct
dimensions. The assertion now accepts either correct measured areas or a
clearly identified partial total. The fixture geometry was also corrected to
match its declared dimensions. No call-count limit was relaxed.

Other verification:

- `npm test`: 27 passed; the optional Snowdon test skipped because no file was supplied.
- Both published Python examples execute successfully, including empty matches;
  rerun after the fixture correction.
- Viewer: 26 relevant tests passed, plus TypeScript checking.
- Real browser agent through the local API: Unicode filename, two Python calls,
  then BCF application; two colored windows, preserved visibility, no issues.
  Captured API requests contained no raw IFC contents.

Initial browser Python startup took about 32 seconds in that smoke test; the
second execution took 0.1 seconds. Model round trips and intermittent connection
resets still affect elapsed time. Earlier repeats also showed occasional extra
inspection calls, so a successful run is not a deterministic guarantee.

Local evidence (ignored, includes tool definitions and generated artifacts):

- Baseline: `.ifc-mcp/evals/2026-09-14T11-20-32-297Z/`
- Final full run: `.ifc-mcp/evals/2026-09-14T13-21-24-801Z/`
- Final rechecks: `.ifc-mcp/evals/2026-09-14T13-31-38-254Z/`

Run `npm run test:prompts` with `OPENAI_API_KEY` and optionally `OPENAI_BASE_URL`.
Use `IFC_EVAL_FILTER` and `IFC_EVAL_REPEAT` for targeted repeats. The live suite
is opt-in; ordinary regression tests do not make model calls.
