import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureLeadInCRM } from "../src/features/inbox/services/crm-sync-service.ts";

const workspaceId = "c34a31ca-2354-4c12-aa5d-79876eff280d";
const contactId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

test("contact without hl_contact_id syncs to GHL once", async () => {
  let syncCalls = 0;
  const result = await ensureLeadInCRM({
    workspaceId,
    contactId,
    deps: {
      loadContact: async () => ({ hl_contact_id: null }),
      syncContactToHL: async () => {
        syncCalls += 1;
        return { hl_id: "hl_123" };
      },
      generateWithTools: async () => {
        throw new Error("generateWithTools must not run");
      },
      dispatchText: async () => {
        throw new Error("dispatchText must not run");
      },
    },
  });

  assert.equal(syncCalls, 1);
  assert.equal(result.status, "synced");
  assert.equal(result.hlContactId, "hl_123");
});

test("contact with hl_contact_id does not call GHL again", async () => {
  let syncCalls = 0;
  const result = await ensureLeadInCRM({
    workspaceId,
    contactId,
    deps: {
      loadContact: async () => ({ hl_contact_id: "hl_existing" }),
      syncContactToHL: async () => {
        syncCalls += 1;
        return { hl_id: "hl_existing" };
      },
    },
  });

  assert.equal(syncCalls, 0);
  assert.equal(result.status, "already_synced");
  assert.equal(result.hlContactId, "hl_existing");
});

test("GHL disconnected or failed does not throw and Eva flow can continue", async () => {
  const disconnected = await ensureLeadInCRM({
    workspaceId,
    contactId,
    deps: {
      loadContact: async () => ({ hl_contact_id: null }),
      syncContactToHL: async () => null,
    },
  });
  assert.equal(disconnected.status, "not_synced");
  assert.equal(disconnected.hlContactId, null);

  const failed = await ensureLeadInCRM({
    workspaceId,
    contactId,
    deps: {
      loadContact: async () => ({ hl_contact_id: null }),
      syncContactToHL: async () => {
        throw new Error("GHL 500");
      },
    },
  });
  assert.equal(failed.status, "not_synced");
  assert.equal(failed.hlContactId, null);

  const missing = await ensureLeadInCRM({
    workspaceId,
    contactId,
    deps: {
      loadContact: async () => null,
      syncContactToHL: async () => {
        throw new Error("must not sync missing contact");
      },
    },
  });
  assert.equal(missing.status, "missing_contact");
});

test("CRM sync does not call generateWithTools or dispatchText", async () => {
  const calls: string[] = [];
  await ensureLeadInCRM({
    workspaceId,
    contactId,
    deps: {
      loadContact: async () => ({ hl_contact_id: null }),
      syncContactToHL: async () => ({ hl_id: "hl_123" }),
      generateWithTools: async () => {
        calls.push("generateWithTools");
        return null;
      },
      dispatchText: async () => {
        calls.push("dispatchText");
        return null;
      },
    },
  });
  assert.deepEqual(calls, []);
});

test("CRM sync does not depend on EVA_SHADOW_ENABLED", async () => {
  const run = (env: Record<string, string>) =>
    ensureLeadInCRM({
      workspaceId,
      contactId,
      env,
      deps: {
        loadContact: async () => ({ hl_contact_id: null }),
        syncContactToHL: async () => ({ hl_id: "hl_123" }),
      },
    });

  const off = await run({ EVA_SHADOW_ENABLED: "false" });
  const on = await run({ EVA_SHADOW_ENABLED: "true" });
  assert.equal(off.status, "synced");
  assert.equal(on.status, "synced");
  assert.equal(off.hlContactId, on.hlContactId);
});
