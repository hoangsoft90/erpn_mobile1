/**
 * P4-2 — `GET|POST /read/daily-summary` (plan4_final §4.2/§4.3/§5/§7).
 *
 * What this file proves, and how:
 *
 *  1. ROUTE: the drawer reaches the day's aggregate by URL + optional `date`,
 *     in both shapes (query for GET, JSON body for POST), with NO NLP service
 *     running anywhere in this file and NO classifier call — the id is given,
 *     never inferred from a phrase.
 *  2. DAY: absent date = TODAY AT THE SHOP (Asia/Ho_Chi_Minh), not the host's
 *     day — tested at the 23:59/00:00 VN boundary with fixed instants (§7.7),
 *     plus a request whose fixture rows sit on `vnToday()`.
 *  3. COMPANY: resolved SERVER-SIDE (config pin, else the ERPNext session's own
 *     default company). A client-supplied company is a CLAIM that is checked,
 *     never honored — a mismatch is refused instead of silently answered from
 *     another company's books.
 *  4. PARTIAL: a failing ERP branch comes straight back as `meta.partial` with
 *     a NULL block (never a fabricated 0) and HTTP 200 — the client renders
 *     per-block errors, so flattening that into a 5xx would lose the blocks
 *     that DID read.
 *  5. FAILURES: 400 (bad date/body), 429 (READ bucket), 503 (no company to
 *     read, or the session read itself failing), 401 on a non-loopback bind.
 *
 * Hermetic: every ERPNEXT_ / ASK_ prefixed variable is stripped and the mock is
 * opt-in (COPILOT_MOCK_OK=1) — a missing config must never become fixture data.
 */

for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}
// The FILe's own opt-in: this suite drives the fixture server on purpose.
process.env.COPILOT_MOCK_OK = "1";
delete process.env.COPILOT_COMPANY;
delete process.env.COPILOT_USERS;
delete process.env.ERPN_CAPABILITY_CONTRACT;

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const D = "2026-09-21";
const COMPANY = "Minh Phát Cám & VLXD";
const CASH = "1110 - Tiền mặt - MP";
const BANK = "1210 - ACB 110296868 - MP";
const DEBTORS = "1310 - Phải thu khách hàng - MP";

/* ----------------------------------------------------------------- fixture */
/* One compact day (P4-1 carries the full 20-document review3 matrix). Numbers
 * here are DERIVED from the rows below, never typed from a remembered total. */

function fixture(day = D) {
  return {
    Company: [
      { name: COMPANY, default_cash_account: CASH, default_bank_account: BANK, company: COMPANY },
    ],
    Account: [
      { name: CASH, account_type: "Cash", company: COMPANY },
      { name: BANK, account_type: "Bank", company: COMPANY },
      { name: DEBTORS, account_type: "Receivable", company: COMPANY },
    ],
    "GL Entry": [
      // Opening: +5.000.000 on the day BEFORE `day`.
      { posting_date: "2026-09-20", account: CASH, debit: 5_000_000, credit: 0, is_cancelled: 0 },
    ],
    "Sales Order": [
      { name: "SO-1", docstatus: 1, status: "To Deliver", grand_total: 12_000_000, transaction_date: day, company: COMPANY },
      { name: "SO-2", docstatus: 0, status: "Draft", grand_total: 99_000_000, transaction_date: day, company: COMPANY },
    ],
    "Sales Invoice": [
      { name: "INV-1", docstatus: 1, status: "Unpaid", grand_total: 20_000_000, outstanding_amount: 20_000_000, due_date: "2026-09-10", posting_date: day, company: COMPANY },
    ],
    "Payment Entry": [
      {
        name: "PE-1", docstatus: 1, status: "Submitted", posting_date: day, payment_type: "Receive",
        party_type: "Customer", paid_amount: 7_000_000, received_amount: 7_000_000,
        paid_to: CASH, paid_from: DEBTORS, company: COMPANY, unallocated_amount: 0,
        references: [{ reference_name: "INV-1" }], mode_of_payment: "Cash",
      },
    ],
  };
}

const SO_SUBMITTED = { count: 1, amount: 12_000_000 };
const SO_DRAFT = { count: 1, amount: 99_000_000 };
const SI_AMOUNT = 20_000_000;
const RECEIPTS_TOTAL = 7_000_000;
const DRAWER_CLOSING = 5_000_000 + 7_000_000;

/* ----------------------------------------------------------------- harness */

/**
 * Run `fn` with the fixture env installed, restoring EXACTLY the keys this
 * helper touched.
 *
 * A hardcoded restore list is how this harness first went wrong: COPILOT_COMPANY
 * was set by one test, never restored, and the next test's "no company → 503"
 * came back 200 from the leaked pin. Environment that survives a test makes the
 * following one pass for a different reason than the one it claims.
 */
async function withFixture(over, fn) {
  const touched = ["MOCK_ERP_P4_FIXTURE", ...Object.keys(over.env ?? {})];
  const saved = touched.map((k) => [k, process.env[k]]);
  process.env.MOCK_ERP_P4_FIXTURE = JSON.stringify(fixture(over.day ?? D));
  for (const [k, v] of Object.entries(over.env ?? {})) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * One server per call. `env` is the config seam createAskServer exposes
 * (COPILOT_COMPANY / COPILOT_USERS); it is NOT the process env the ERP target
 * is picked from, so the mock stays opt-in via process.env above.
 */
async function startServer({ env = {}, principal = null, limiter = null, host = "127.0.0.1", policy = null } = {}) {
  const { createAskServer } = await import("../src/http-ask.mjs");
  const server = createAskServer({ port: 0, host, principal, limiter, policy, env: { ...process.env, ...env } });
  await new Promise((resolve) => server.listen(0, host, resolve));
  const port = server.address().port;
  return {
    base: `http://${host}:${port}`,
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const get = (base, qs = "") => fetch(`${base}/read/daily-summary${qs}`);
const post = (base, body) =>
  fetch(`${base}/read/daily-summary`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/* -------------------------------------------------------- 1. the VN day */

test("P4-2 date: the day is the SHOP's (Asia/Ho_Chi_Minh), not the host's — 23:59 vs 00:00 VN", async () => {
  const { vnToday } = await import("../src/http-ask.mjs");
  // 2026-09-21T16:59Z = 23:59 VN on 09-21; 17:00Z = 00:00 VN on 09-22.
  assert.equal(vnToday(new Date("2026-09-21T16:59:00Z")), "2026-09-21");
  assert.equal(vnToday(new Date("2026-09-21T17:00:00Z")), "2026-09-22");
  assert.equal(vnToday(new Date("2026-09-21T17:30:00Z")), "2026-09-22");
  // Control: the formatter really is YYYY-MM-DD (a DD/MM/YYYY formatter would
  // make the assertions above pass for the wrong reason on some days).
  assert.match(vnToday(new Date("2026-01-05T03:00:00Z")), /^\d{4}-\d{2}-\d{2}$/);
});

/* ------------------------------------------------------- 2. happy paths */

test("P4-2: POST with an explicit date returns the §4.3 object (server-side aggregate)", async () => {
  await withFixture({}, async () => {
    const s = await startServer();
    try {
      const res = await post(s.base, { date: D });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.deepEqual(body.sales_orders.submitted, SO_SUBMITTED);
      assert.deepEqual(body.sales_orders.draft, SO_DRAFT);
      assert.equal(body.sales_invoices.amount, SI_AMOUNT);
      assert.equal(body.sales_invoices.includes_draft, false);
      assert.equal(body.receipts.against_invoice, RECEIPTS_TOTAL);
      assert.equal(body.receipts.total, RECEIPTS_TOTAL);
      assert.equal(body.receivables.outstanding_total, SI_AMOUNT);
      assert.equal(body.receivables.overdue_count, 1);
      assert.equal(body.cash_drawer.opening, 5_000_000);
      assert.equal(body.cash_drawer.expected_closing, DRAWER_CLOSING);
      assert.equal(body.meta.partial, false);
      assert.deepEqual(body.meta.errors, []);
      assert.equal(body.meta.date, D);
      assert.equal(body.meta.company, COMPANY);
      // Provenance: the drawer prints REAL|MOCK beside the money, so the route
      // must ship the target it really used. Reaching the fixture branch AT ALL
      // means no ERPNEXT_URL was configured (pickServerScript would have taken
      // the real/partial branch), so "MOCK" is the only honest answer here —
      // and it must equal the helper the startup log uses.
      const { erpTargetLabel } = await import("../src/copilot-server.mjs");
      assert.equal(body.meta.erp_target, "MOCK", "fixture run must be labelled MOCK");
      assert.equal(body.meta.erp_target, erpTargetLabel(process.env));
      // The capability is READ and produces no executable intent: nothing to
      // confirm, nothing to execute, no correlation id for a write.
      assert.equal("command_id" in body, false);
      assert.equal("proposal" in body, false);
    } finally {
      await s.close();
    }
  });
});

test("P4-2: GET with ?date= answers the same day as the POST body", async () => {
  await withFixture({}, async () => {
    const s = await startServer();
    try {
      const res = await get(s.base, `?date=${D}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.meta.date, D);
      assert.equal(body.sales_invoices.amount, SI_AMOUNT);
    } finally {
      await s.close();
    }
  });
});

test("P4-2: an absent date means TODAY AT THE SHOP (fixture rows sit on vnToday())", async () => {
  const { vnToday } = await import("../src/http-ask.mjs");
  const today = vnToday();
  await withFixture({ day: today }, async () => {
    const s = await startServer();
    try {
      const viaGet = await (await get(s.base)).json();
      assert.equal(viaGet.meta.date, today);
      // Non-zero on purpose: the rows are on the VN day, so a default that
      // silently used the host's day (or UTC) would report an EMPTY day here.
      assert.equal(viaGet.sales_invoices.amount, SI_AMOUNT);
      assert.deepEqual(viaGet.sales_orders.submitted, SO_SUBMITTED);

      const viaPost = await (await post(s.base, {})).json();
      assert.equal(viaPost.meta.date, today);
      assert.equal(viaPost.sales_invoices.amount, SI_AMOUNT);
    } finally {
      await s.close();
    }
  });
});

test("P4-2: POST body date wins over a query date (one request, one day)", async () => {
  await withFixture({}, async () => {
    const s = await startServer();
    try {
      const res = await fetch(`${s.base}/read/daily-summary?date=2026-09-20`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: D }),
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.meta.date, D);
      assert.equal(body.sales_invoices.amount, SI_AMOUNT);
    } finally {
      await s.close();
    }
  });
});

test("P4-2: the route needs no NLP service and no phrase to work (no classifier path)", async () => {
  // Nothing in this file starts the Python NLP bridge, and NLP_SERVICE_PORT is
  // not even set — a route that consulted the classifier would fail here.
  assert.equal(process.env.NLP_SERVICE_PORT, undefined);
  await withFixture({}, async () => {
    const s = await startServer();
    try {
      const res = await post(s.base, { date: D });
      assert.equal(res.status, 200);
    } finally {
      await s.close();
    }
  });
});

/* --------------------------------------------------- 3. company resolution */

test("P4-2 company: unpinned config falls back to the ERPNext session default (server-side)", async () => {
  await withFixture({ env: { MOCK_ERP_DEFAULT_COMPANY: COMPANY } }, async () => {
    const s = await startServer();
    try {
      const res = await get(s.base, `?date=${D}`);
      const body = await res.json();
      assert.equal(res.status, 200);
      // Exactly the session default, with no company in the request at all.
      assert.equal(body.meta.company, COMPANY);
      assert.equal(body.sales_invoices.amount, SI_AMOUNT);
    } finally {
      await s.close();
    }
  });
});

test("P4-2 company: a config pin wins and the session default is not even read", async () => {
  await withFixture(
    { env: { COPILOT_COMPANY: COMPANY, MOCK_ERP_FAIL_GLOBAL_DEFAULTS: "1" } },
    async () => {
      const s = await startServer({ env: { COPILOT_COMPANY: COMPANY } });
      try {
        const res = await get(s.base, `?date=${D}`);
        const body = await res.json();
        // Reading Global Defaults here would 503 (the fail knob is on), so a
        // 200 proves the pinned company was used without a session read.
        assert.equal(res.status, 200, JSON.stringify(body));
        assert.equal(body.meta.company, COMPANY);
      } finally {
        await s.close();
      }
    },
  );
});

test("P4-2 company: a client-supplied company that DISAGREES is refused, not silently ignored", async () => {
  await withFixture({}, async () => {
    const s = await startServer();
    try {
      const res = await post(s.base, { date: D, company: "SANLOAN" });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.code, "COMPANY_SCOPE_MISMATCH");
      assert.match(body.error, /SANLOAN/);
      // No partial answer leaked alongside the refusal.
      assert.equal("sales_invoices" in body, false);

      // Control: the SAME claim matching what the server resolved is not a
      // refusal — the rule is "the client may not redirect the scope", not
      // "the field is banned".
      const ok = await post(s.base, { date: D, company: COMPANY });
      assert.equal(ok.status, 200, JSON.stringify(await ok.json()));
    } finally {
      await s.close();
    }
  });
});

/* ------------------------------------------------------------ 4. partial */

test("P4-2 partial: a failing ERP branch is a 200 with a NULL block — never a fabricated 0", async () => {
  await withFixture({ env: { MOCK_ERP_FAIL_LIST: "1" } }, async () => {
    const s = await startServer();
    try {
      const res = await get(s.base, `?date=${D}`);
      assert.equal(res.status, 200, "partial data is not an HTTP failure");
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.meta.partial, true);
      assert.ok(body.meta.errors.length > 0);
      const blocks = body.meta.errors.map((e) => e.block);
      for (const block of ["sales_orders", "sales_invoices", "receipts", "receivables", "app_drafts"]) {
        assert.ok(blocks.includes(block), `${block} must be reported as failed`);
      }
      // The money property: the failed blocks are null, and NO 0 was invented.
      assert.equal(body.sales_orders, null);
      assert.equal(body.sales_invoices, null);
      assert.equal(body.receipts, null);
      assert.equal(body.payments_out, null);
      assert.equal(body.receivables, null);
      assert.equal(body.app_drafts, null);
      assert.equal(body.cash_drawer, null);
      assert.equal(body.returns, null);
    } finally {
      await s.close();
    }
  });
});

test("P4-2 app_drafts: ONE doctype without the correlation field is a NULL block — and the failure stays SCOPED", async () => {
  // This is the state the real site was in until 2026-09-21 (Custom Field on
  // Payment Entry only). The MOCK_ERP_FAIL_LIST case above cannot prove scope:
  // it fails EVERY branch, so a skill that swallowed all errors would pass it.
  // Here only `Sales Order` cannot be filtered by the column.
  await withFixture({ env: { MOCK_ERP_SO_NO_CORRELATION_FIELD: "1" } }, async () => {
    const s = await startServer();
    try {
      const body = await (await get(s.base, `?date=${D}`)).json();
      assert.equal(body.meta.partial, true);
      assert.equal(body.app_drafts, null, "an unanswerable app_drafts must stay NULL, never 0");
      const err = body.meta.errors.find((e) => e.block === "app_drafts");
      assert.ok(err, "the failed block must be NAMED so the card can say which one is unread");
      assert.equal(err.code, "ERP_UNAVAILABLE");
      assert.match(err.detail, /custom_ai_action_id/, "the detail must name the missing column");
      // CONTROL: the other blocks still carry the SAME numbers as the happy
      // path ⇒ the failure is scoped, not a blanket outage wearing a per-block
      // label (which is what MOCK_ERP_FAIL_LIST simulates).
      assert.deepEqual(body.sales_orders.submitted, SO_SUBMITTED);
      assert.deepEqual(body.sales_orders.draft, SO_DRAFT);
      assert.equal(body.sales_invoices.amount, SI_AMOUNT);
      assert.equal(body.receipts.total, RECEIPTS_TOTAL);
      assert.equal(body.receivables.outstanding_total, SI_AMOUNT);
      assert.equal(body.cash_drawer.expected_closing, DRAWER_CLOSING);
    } finally {
      await s.close();
    }
  });
});

test("P4-2 app_drafts: with all four doctypes correlated the block READS — a 0-draft day is a real answer", async () => {
  // The non-vacuous counterpart of the test above: "no drafts today" is only
  // allowed to be printed when the site COULD have answered. Same fixture, same
  // day — the only difference is whether the column exists.
  await withFixture({}, async () => {
    const s = await startServer();
    try {
      const body = await (await get(s.base, `?date=${D}`)).json();
      assert.equal(body.meta.partial, false);
      assert.deepEqual(body.app_drafts, { count: 0, by_type: {} });
    } finally {
      await s.close();
    }
  });
});

/* ----------------------------------------------------------- 5. refusals */

test("P4-2 400: dates that do not exist on the calendar are refused (regex is not enough)", async () => {
  await withFixture({}, async () => {
    const s = await startServer();
    try {
      for (const bad of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-9-21", "21-09-2026", "2026-09-21T00:00:00Z", "not-a-date", "0000-01-01"]) {
        const res = await get(s.base, `?date=${encodeURIComponent(bad)}`);
        assert.equal(res.status, 400, `${bad} must be refused`);
        const body = await res.json();
        assert.equal(body.code, "INVALID_DATE");
        assert.equal("sales_invoices" in body, false);
      }
      // Non-string shapes are refused too (a number is a natural client bug).
      for (const bad of [123, true, ["2026-09-21"], { year: 2026 }]) {
        const res = await post(s.base, { date: bad });
        assert.equal(res.status, 400, `${JSON.stringify(bad)} must be refused`);
        assert.equal((await res.json()).code, "INVALID_DATE");
      }
      // Controls: a real leap day passes, and an empty date means "today".
      const leap = await get(s.base, "?date=2024-02-29");
      assert.equal(leap.status, 200);
      assert.equal((await leap.json()).meta.date, "2024-02-29");
      const blank = await get(s.base, "?date=");
      assert.equal(blank.status, 200);
    } finally {
      await s.close();
    }
  });
});

test("P4-2 400: a malformed JSON body and a non-string company are refused before any read", async () => {
  await withFixture({}, async () => {
    const s = await startServer();
    try {
      const badJson = await fetch(`${s.base}/read/daily-summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      assert.equal(badJson.status, 400);
      assert.equal((await badJson.json()).code, "BAD_REQUEST");

      const badCompany = await post(s.base, { date: D, company: 42 });
      assert.equal(badCompany.status, 400);
      assert.equal((await badCompany.json()).code, "INVALID_COMPANY");
    } finally {
      await s.close();
    }
  });
});

test("P4-2 429: the READ bucket is charged before any ERP read", async () => {
  await withFixture({}, async () => {
    const { RateLimiter } = await import("../src/rate-limit.mjs");
    const limiter = new RateLimiter({
      rules: { perUser: { read: { limit: 1, windowMs: 60_000 } }, perCapability: {} },
    });
    // Exhaust the single slot for the userId the loopback server resolves.
    assert.equal(limiter.chargeUser("read", "local").ok, true);
    const s = await startServer({ limiter });
    try {
      const res = await get(s.base, `?date=${D}`);
      assert.equal(res.status, 429);
      const body = await res.json();
      assert.equal(body.code, "RATE_LIMITED");
      assert.ok(body.retry_after_ms > 0);
      assert.ok(Number(res.headers.get("retry-after")) >= 1);
    } finally {
      await s.close();
    }
  });
});

test("P4-2 503: no company to read (no pin, site has no default) says what to configure", async () => {
  await withFixture({ env: { MOCK_ERP_DEFAULT_COMPANY: "" } }, async () => {
    const s = await startServer();
    try {
      const res = await get(s.base, `?date=${D}`);
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.code, "COMPANY_UNRESOLVED");
      assert.match(body.error, /COPILOT_COMPANY/);
      // Refusing is the point: a site with several companies must never be
      // answered from whichever row happened to come back first.
      assert.equal("sales_invoices" in body, false);
    } finally {
      await s.close();
    }
  });
});

test("P4-2 503: a failing session-company read is a refusal, not a guessed company", async () => {
  await withFixture({ env: { MOCK_ERP_FAIL_GLOBAL_DEFAULTS: "1" } }, async () => {
    const s = await startServer();
    try {
      const res = await get(s.base, `?date=${D}`);
      assert.equal(res.status, 503);
      assert.equal((await res.json()).ok, false);
    } finally {
      await s.close();
    }
  });
});

test("P4-2 503: an unconfigured ERP target is a refusal — the route can never take the service down", async () => {
  // No fixture and no credentials: pickServerScript() throws. The throw is
  // inside the handler's try on purpose — an async listener that rejects is an
  // UNHANDLED REJECTION, and Node exits, so one bad drawer request would kill
  // /ask too. This test fails by TIMING OUT/HANGING if that regresses, which is
  // the honest shape of the failure (the process is gone).
  const saved = process.env.COPILOT_MOCK_OK;
  delete process.env.COPILOT_MOCK_OK;
  const s = await startServer();
  try {
    const res = await get(s.base, `?date=${D}`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "ERP_UNAVAILABLE");
    // Still standing: this second request is answered at all only because the
    // first one did not take the process down.
    const health = await fetch(`${s.base}/health`);
    assert.equal(health.status, 200);
  } finally {
    if (saved === undefined) delete process.env.COPILOT_MOCK_OK;
    else process.env.COPILOT_MOCK_OK = saved;
    await s.close();
  }
});

test("P4-2 401: a non-loopback bind requires the same basic auth as /ask", async () => {
  await withFixture({}, async () => {
    // 127.0.0.2 is inside 127/8 (safe to bind in CI) while the POLICY object
    // exercises the non-loopback branch, exactly as http-ask-auth.test.mjs does.
    const policy = { loopback: false, user: "op", password: "correct horse battery" };
    const s = await startServer({ policy, host: "127.0.0.2" });
    try {
      const no = await fetch(`http://127.0.0.2:${s.port}/read/daily-summary?date=${D}`);
      assert.equal(no.status, 401);
      assert.equal((await no.json()).error, "unauthorized");

      const auth = "Basic " + Buffer.from("op:correct horse battery").toString("base64");
      const yes = await fetch(`http://127.0.0.2:${s.port}/read/daily-summary?date=${D}`, {
        headers: { authorization: auth },
      });
      assert.equal(yes.status, 200, "the credential that works for /ask works here");
      assert.equal((await yes.json()).meta.date, D);
    } finally {
      await s.close();
    }
  });
});

/* ------------------------------------------------- 6. static tripwires */

test("P4-2 static: the route holds no write surface and never calls the classifier", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const source = readFileSync(`${here}../src/http-ask.mjs`, "utf8");
  const start = source.indexOf('path === "/read/daily-summary"');
  const end = source.indexOf('path === "/ocr"', start);
  assert.ok(start > 0 && end > start, "the daily-summary route block was located");
  const block = source.slice(start, end);
  assert.ok(block.length > 1000, `the scan really read the route (${block.length} chars)`);
  // Comments are stripped FIRST: this file's own comments talk ABOUT the
  // classifier and about writes, and a tripwire tripped by its own explanation
  // is a tripwire nobody keeps (lesson from the filter-literal guard).
  const code = block.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const forbidden of [
    "routeIntent",
    "answerQuestion",
    "normalizeText",
    "callWriteTool",
    "runExecute",
    "/execute",
    "command_id",
    "safety",
  ]) {
    assert.equal(
      code.includes(forbidden),
      false,
      `the daily-summary route must not reference "${forbidden}"`,
    );
  }
  // Positive control: the block is the one that runs the READ skill.
  assert.match(code, /getDailySummary\(/);
});
