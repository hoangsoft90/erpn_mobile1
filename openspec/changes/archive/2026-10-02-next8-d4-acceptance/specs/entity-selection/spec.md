# next8 / D4 — Acceptance mapping (plan_final_v3 §11 → evidence)

> Verification-only change: NO behaviour change. This section records WHERE each
> acceptance case is proven, so the archive carries the map, not just a claim.

## ADDED Requirements

### Requirement: The entity-selection acceptance table is executed, not asserted

Every case T1–T16 of plan_final_v3 §11 MUST map to an EXECUTED test (suite + test
name) or carry an explicit SKIP reason (the entity/path does not exist in the product —
e.g. no Invoice picker). A T-case claimed PASS without a runnable test or a skip
reason does not count toward the FIXED verdict. The H6 answer (CONFIRMED/REJECTED)
must cite executed evidence (suite output), and the no-regression claim for
next6/next7 must cite the suites that pin them.

#### Scenario: the final report's T-table rows point at evidence

- **WHEN** `.plan/next8/next8-final-result.md` is produced (plan §13 A–H)
- **THEN** every T1–T16 row names the suite + test that proves it (or SKIP + reason),
  the H6 row cites the session-context suite output, and the verdict is FIXED only
  when all rows resolve to executed evidence or justified skips