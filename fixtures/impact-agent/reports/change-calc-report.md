## Testpilot test selection

**Confidence: 1.00** (threshold 0.7) — reasoning trusted, running the selected set.

- ✅ **1 must-run**
- 🟡 **1 should-run**
- ⏭️ **1 skipped** — estimated **0.1 minutes** saved

### ✅ Must run

- `src/calc.test.ts` — Direct import (depth 1) from src/calc.ts means this test is definitely impacted. (confidence 1.00)

### 🟡 Should run

- `src/calc-user.test.ts` — Reachable from src/calc.ts at depth 2 via direct imports, so it may be affected. (confidence 0.80)

### ⏭️ Skipped

- `src/unrelated.test.ts` — No import path from the changed file; test is unrelated based on lack of reachability. (confidence 1.00)

<details>
<summary>Confidence signals</summary>

| Signal | Value |
|---|---|
| Diff completeness | 1.00 |
| Graph coverage | 1.00 |
| Graph certainty | 1.00 |
| Selection completeness | 1.00 |

</details>

*Estimated minutes saved assumes 0.1 min/unit test, 0.5 min/integration test, 2 min/e2e test — placeholders until real historical run-time data is tracked (Phase 5), not measurements. Confidence is a weighted score over observable signals — never invented by the model — and this run's threshold is a starting value pending calibration (Phase 6).*