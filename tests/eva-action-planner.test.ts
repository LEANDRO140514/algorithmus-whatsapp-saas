import assert from "node:assert/strict";
import { test } from "node:test";
import { EvaContractV1OutputSchema } from "../src/features/agents/contracts/eva-contract-v1.ts";
import { planEvaActions } from "../src/features/agents/services/action-planner.ts";

test("valid output with intent.key null can be planned and keeps intent_key null", () => {
  const parsed = EvaContractV1OutputSchema.safeParse({
    contract_version: "eva-v1",
    reply: "Te agendo un seguimiento.",
    intent: {
      key: null,
      status: "unknown",
      confidence: null,
      evidence: [],
    },
    qualification: {
      career_key: null,
      modality_key: null,
      status: "unknown",
      confidence: null,
      evidence: [],
    },
    handoff: { requested: false, reason: null, note: null },
    memory_updates: [
      {
        section: "business_state",
        key: "suggested_next_step",
        value: "follow_up",
        evidence: null,
      },
    ],
    proposed_actions: [
      {
        type: "follow_up_requested",
        reason: "callback",
        preferred_date: null,
        preferred_time_window: null,
        note: null,
      },
    ],
  });

  assert.equal(parsed.success, true);
  if (!parsed.success) return;

  const planned = planEvaActions(parsed.data);
  assert.equal(planned.length, 1);
  assert.equal(planned[0]?.actionType, "followup.prepare");
  assert.equal(planned[0]?.payload.intent_key, null);
});
