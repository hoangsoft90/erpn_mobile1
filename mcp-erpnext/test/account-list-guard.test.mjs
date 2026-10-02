import test from "node:test";
import assert from "node:assert/strict";
import { READ_ONLY_TOOLS, assertReadOnly } from "../src/readonly-guard.mjs";

test("account_list is whitelisted (the write path resolves accounts from it)", () => {
  assert.ok(READ_ONLY_TOOLS.includes("erpnext_account_list"));
  assert.ok(assertReadOnly("erpnext_account_list"));
});

