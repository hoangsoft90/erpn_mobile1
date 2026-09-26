/**
 * Tests for the /ask bind policy + basic auth (user decision 2026-09-14:
 * real customer debt data must never be exposed on a public interface
 * without auth — the server hard-refuses unsafe binds at startup).
 *
 *   1. resolveBindPolicy: loopback (no auth), non-loopback requires creds,
 *      password >= 8, public interfaces refused unless ASK_ALLOW_PUBLIC=1,
 *      Tailscale/CGNAT (100.x) and RFC1918 count as private.
 *   2. Real HTTP: 401 without credentials, 200 with credentials — on a
 *      non-loopback bind over the loopback address (127.0.0.2, still
 *      127/8) so no public interface is touched during tests.
 *
 * Env is scrubbed of ERPNEXT_* (hermetic, lesson from result9).
 */

for (const k of Object.keys(process.env)) {
  if (k.startsWith("ERPNEXT_")) delete process.env[k];
}

import test from "node:test";
import assert from "node:assert/strict";
import { resolveBindPolicy, createAskServer } from "../src/http-ask.mjs";

const ENV = {
  ASK_USER: "op",
  ASK_PASSWORD: "correct horse battery",
  // NOT public by default — tests for public must pass the flag explicitly.
};

test("policy: loopback bind needs no auth, and rejects cred env as a mistake", () => {
  const p = resolveBindPolicy({ host: "127.0.0.1", env: {} });
  assert.equal(p.loopback, true);
  assert.equal(p.user, null);
  assert.throws(
    () => resolveBindPolicy({ host: "127.0.0.1", env: { ASK_USER: "x", ASK_PASSWORD: "yyyyyyyy" } }),
    /make no sense/,
  );
});

test("policy: non-loopback without creds is REFUSED", () => {
  for (const host of ["10.88.0.4", "0.0.0.0", "100.64.0.1", "192.168.1.50"]) {
    assert.throws(() => resolveBindPolicy({ host, env: {} }), /refusing to bind non-loopback/, host);
  }
});

test("policy: short password refused", () => {
  assert.throws(
    () => resolveBindPolicy({ host: "10.88.0.4", env: { ASK_USER: "op", ASK_PASSWORD: "short" } }),
    /at least 8/,
  );
});

test("policy: private interfaces (RFC1918 + Tailscale CGNAT) bind with creds", () => {
  for (const host of ["10.88.0.4", "192.168.1.50", "172.20.0.9", "100.64.0.1", "100.101.102.103"]) {
    const p = resolveBindPolicy({ host, env: ENV });
    assert.equal(p.loopback, false);
    assert.equal(p.user, "op");
  }
});

test("policy: Tailscale CGNAT boundary — 100.64.0.0/10 is private, rest of 100/8 is PUBLIC", () => {
  // Private: 100.64.0.0 – 100.127.255.255
  for (const host of ["100.64.0.1", "100.100.0.1", "100.127.255.254"]) {
    const p = resolveBindPolicy({ host, env: ENV });
    assert.equal(p.public, false, host);
  }
  // Public (regression for review 2026-09-14: old code treated ALL of 100/8 as private):
  for (const host of ["100.0.1.1", "100.63.255.254", "100.128.0.1", "100.200.1.1"]) {
    assert.throws(() => resolveBindPolicy({ host, env: ENV }), /refusing to bind public/, host);
  }
});

test("policy: public interface refused unless ASK_ALLOW_PUBLIC=1", () => {
  assert.throws(
    () => resolveBindPolicy({ host: "35.194.130.120", env: ENV }),
    /refusing to bind public interface/,
  );
  const p = resolveBindPolicy({ host: "35.194.130.120", env: { ...ENV, ASK_ALLOW_PUBLIC: "1" } });
  assert.equal(p.loopback, false);
});

test("policy: public bind of 0.0.0.0 requires both auth and the explicit flag", () => {
  assert.throws(() => resolveBindPolicy({ host: "0.0.0.0", env: ENV }), /refusing to bind public/);
  const p = resolveBindPolicy({ host: "0.0.0.0", env: { ...ENV, ASK_ALLOW_PUBLIC: "1" } });
  assert.equal(p.loopback, false);
});

test("policy: 127/8 other addresses are still loopback (safe) — non-loopback branch exercised via explicit policy below", () => {
  const p = resolveBindPolicy({ host: "127.0.0.2", env: {} });
  assert.equal(p.loopback, true);
});

test("http: non-loopback bind answers 401 without creds, 200 with creds", async () => {
  // 127.0.0.2 is inside 127/8 (still the loopback interface) so the address is
  // safe to bind in CI while the POLICY object exercises the non-loopback branch.
  const policy = { loopback: false, user: ENV.ASK_USER, password: ENV.ASK_PASSWORD };
  const server = createAskServer({ port: 0, host: "127.0.0.2", policy });
  await new Promise((r) => server.listen(0, "127.0.0.2", r));
  const port = server.address().port;
  try {
    const no = await fetch(`http://127.0.0.2:${port}/health`);
    assert.equal(no.status, 401);
    const body = await no.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, "unauthorized");

    const auth = "Basic " + Buffer.from("op:correct horse battery").toString("base64");
    const yes = await fetch(`http://127.0.0.2:${port}/health`, { headers: { authorization: auth } });
    assert.equal(yes.status, 200);
    const hb = await yes.json();
    assert.equal(hb.ok, true);
    assert.equal(hb.service, "copilot-ask");

    const wrong = await fetch(`http://127.0.0.2:${port}/health`, {
      headers: { authorization: "Basic " + Buffer.from("op:wrong-password").toString("base64") },
    });
    assert.equal(wrong.status, 401);
  } finally {
    server.close();
  }
});
