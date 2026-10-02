# next8 / Review hardening — cap entity_id + stderr noise (find-bugs L1/L2/L4)

## Why

The second find-bugs review of next8 (2026-09-28, working.md mục 20) confirmed
0 High / 1 Medium / 4 Low. Two of the Low findings are contract inconsistency,
one is log noise. This change hardens them without touching any picker safety
property (hint-not-authority, TTL, bailout, bound-10 stay byte-identical):

- **L2**: `/dsh/ask` shape-checks `entity_id` (≤140 chars, else 400
  `DSH_GATEWAY_BAD_REQUEST`), but `/ask` parses the same field with NO cap —
  the same contract field has two validation standards. `MAX_BODY` (1MB) blocks
  a real DoS, so this is consistency, not vulnerability — but an over-long id
  currently reaches the pipeline (embeds in refusal reasons / stderr logs).
- **L1**: the refusal copy and stderr logs embed the raw `pickedEntityId`.
  Capping the id AT THE BOUNDARY (the fix for L2) caps every echo
  downstream — one guard, all sites bounded.
- **L4**: the inventory branch calls `sessionContext.set("item", {id: null})`
  on EVERY ambiguous-item answer, and the write ALWAYS fails with
  `ok:false` (a null id can never be stored) — one stderr line of noise per
  ambiguous question, forever. The attempted value makes the D1 ".ok must be
  logged" rule meaningless for this call site: there is nothing to remember.

## What Changes

1. **`/ask` caps `entity_id` at 140** — same bound, same 400 shape as
   `/dsh/ask` (`DSH_GATEWAY_BAD_REQUEST`, "entity_id không hợp lệ"). The cap
   constant becomes a shared export (`MAX_ENTITY_ID_LENGTH`) used by both
   routes so the two standards cannot drift again.
2. **The null-id `set("item")` attempt is removed** — the inventory branch
   calls `set()` only AFTER a successful pick (where a real id exists);
   the always-failing null attempt (and its per-question stderr line) is
   deleted. The D1 ".ok check + stderr log" convention stays for the three
   real call sites (item-picked / supplier / customer).
3. **No spec change to picker safety** — stale/ambiguous/bailout/bound
   behaviour is untouched; the D1 spec requirement "every set() call site
   checks .ok" still holds (attempting an entry that cannot ever be stored is
   not remembering anything).

## Impact

- Affected specs: `entity-selection` (ADDED requirement: bounded pick id at
  every HTTP boundary; MODIFIED reading for the context requirement — refused
  writes stay visible for entries that COULD be stored).
- Affected code: `http-ask.mjs` (shared cap + `/ask` check),
  `copilot-server.mjs` (remove the null-id attempt block).
- Tests: new `test/next8-review-hardening.test.mjs` (TDD red→green) pinning
  the /ask 400 and the silent inventory branch; no Flutter change (client
  already sends ERPNext-sized ids, well under 140).
