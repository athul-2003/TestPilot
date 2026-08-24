# Testpilot regression-guard evaluation

**Missed regressions: 0 of 6 scenarios.** This is the trust metric — it must read 0.

**Estimated CI-minute reduction:** 0.0 minutes across 6 scenarios (placeholder per-test-type assumptions — see the report footnote in each run; not a measurement of real test durations).

**Selection efficiency:** 0/20 of the hand-derived "safe to skip" tests were actually skipped — the gap between this and 100% is real tests run that a perfectly-informed tool would not have needed to.

| Scenario | Confidence | Fell back | Must-run | Should-run | Skip | Ideal skip achieved | Missed regression |
|---|---|---|---|---|---|---|---|
| 01-pure-logic-isolated | 1.00 | no | 1 | 4 | 0 | 0/4 | no |
| 02-shared-util-bug | 1.00 | no | 1 | 4 | 0 | 0/2 | no |
| 03-type-only | 1.00 | no | 0 | 5 | 0 | 0/5 | no |
| 04-test-only | 1.00 | no | 1 | 4 | 0 | 0/4 | no |
| 05-config-change | 1.00 | no | 0 | 5 | 0 | 0/5 | no |
| 06-trip-fallback | 0.40 | yes | 5 | 0 | 0 | 0/0 | no |

## Confidence calibration

- ✅ **01-pure-logic-isolated** — confidence 1.00, expected confident, actually stayed confident.
- ✅ **02-shared-util-bug** — confidence 1.00, expected confident, actually stayed confident.
- ✅ **03-type-only** — confidence 1.00, expected confident, actually stayed confident.
- ✅ **04-test-only** — confidence 1.00, expected confident, actually stayed confident.
- ✅ **05-config-change** — confidence 1.00, expected confident, actually stayed confident.
- ✅ **06-trip-fallback** — confidence 0.40, expected fallback, actually fell back.

## Flaky-flag precision

Not measured by this fixture — none of the six scenarios seeds a new or historically-unstable test (that would duplicate the flaky mechanism's own live verification, which already exercised it directly: a real Groq call correctly flagged a genuine `setTimeout`-based flaky pattern with a rationale naming the exact line).