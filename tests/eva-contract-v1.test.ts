import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EvaContractV1InputSchema,
  EvaContractV1OutputSchema,
} from "../src/features/agents/contracts/eva-contract-v1.ts";

const workspaceId = "c34a31ca-2354-4c12-aa5d-79876eff280d";
const conversationId = "11111111-2222-4333-8444-555555555555";
const contactId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    contract_version: "eva-v1",
    workspace_id: workspaceId,
    conversation_id: conversationId,
    contact: { contact_id: contactId, name: "Ana" },
    recent_messages: [
      {
        role: "user",
        content: "Hola",
        created_at: "2026-08-17T00:00:00.000Z",
      },
    ],
    memory: {
      schema_version: "client-memory-v1",
      memory_revision: 1,
      business_state: {},
      relationship_summary: "",
      relationship_facts: {},
      recent_events: [],
    },
    knowledge_context: ["[Fuente: FAQ]\nNo hay examen de admision."],
    ...overrides,
  };
}

function validOutput(overrides: Record<string, unknown> = {}) {
  return {
    contract_version: "eva-v1",
    reply: "Hola, soy Eva.",
    intent: {
      key: "saludo",
      status: "known",
      confidence: 0.9,
      evidence: [{ text: "Hola", source_message_index: 0 }],
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
        key: "last_intent",
        value: "saludo",
        evidence: null,
      },
    ],
    proposed_actions: [
      {
        type: "no_action",
        reason: null,
        preferred_date: null,
        preferred_time_window: null,
        note: null,
      },
    ],
    ...overrides,
  };
}

test("intent.key accepts null with status unknown", () => {
  const parsed = EvaContractV1OutputSchema.safeParse(
    validOutput({
      intent: {
        key: null,
        status: "unknown",
        confidence: null,
        evidence: [],
      },
    }),
  );
  assert.equal(parsed.success, true);
});

test("intent.key still rejects empty string", () => {
  const parsed = EvaContractV1OutputSchema.safeParse(
    validOutput({
      intent: {
        key: "",
        status: "unknown",
        confidence: null,
        evidence: [],
      },
    }),
  );
  assert.equal(parsed.success, false);
});

test("evidence.source_message_index accepts integer >= 0", () => {
  const parsed = EvaContractV1OutputSchema.safeParse(validOutput());
  assert.equal(parsed.success, true);
});

test("evidence.source_message_index rejects null", () => {
  const parsed = EvaContractV1OutputSchema.safeParse(
    validOutput({
      intent: {
        key: "saludo",
        status: "known",
        confidence: 0.9,
        evidence: [{ text: "Hola", source_message_index: null }],
      },
    }),
  );
  assert.equal(parsed.success, false);
});

test("input contract rejects phone on contact", () => {
  const parsed = EvaContractV1InputSchema.safeParse(
    validInput({
      contact: { contact_id: contactId, name: "Ana", phone: "+529999999999" },
    }),
  );
  assert.equal(parsed.success, false);
});

test("input contract rejects phone at the root", () => {
  const parsed = EvaContractV1InputSchema.safeParse(
    validInput({ phone: "+529999999999", normalized_phone: "+529999999999" }),
  );
  assert.equal(parsed.success, false);
});

test("relationship_facts memory update is rejected", () => {
  const parsed = EvaContractV1OutputSchema.safeParse(
    validOutput({
      memory_updates: [
        {
          section: "relationship_facts",
          key: "preferred_campus",
          value: "merida",
          evidence: null,
        },
      ],
    }),
  );
  assert.equal(parsed.success, false);
});

test("relationship_summary memory update is rejected", () => {
  const parsed = EvaContractV1OutputSchema.safeParse(
    validOutput({
      memory_updates: [
        {
          section: "relationship_summary",
          key: null,
          value: "Lead interesado en Derecho",
          evidence: null,
        },
      ],
    }),
  );
  assert.equal(parsed.success, false);
});

test("memory evidence other than null is rejected", () => {
  const parsed = EvaContractV1OutputSchema.safeParse(
    validOutput({
      memory_updates: [
        {
          section: "business_state",
          key: "last_intent",
          value: "saludo",
          evidence: "Hola",
        },
      ],
    }),
  );
  assert.equal(parsed.success, false);
});

test("empty proposed_actions is rejected", () => {
  const parsed = EvaContractV1OutputSchema.safeParse(
    validOutput({ proposed_actions: [] }),
  );
  assert.equal(parsed.success, false);
});

function qualificationOutput(qualification: Record<string, unknown>) {
  return validOutput({
    qualification: {
      confidence: null,
      evidence: [],
      ...qualification,
    },
  });
}

test("partial with career_key only is accepted", () => {
  const parsed = EvaContractV1OutputSchema.safeParse(
    qualificationOutput({
      career_key: "derecho",
      modality_key: null,
      status: "partial",
    }),
  );
  assert.equal(parsed.success, true);
});

test("partial with modality_key only is accepted", () => {
  const parsed = EvaContractV1OutputSchema.safeParse(
    qualificationOutput({
      career_key: null,
      modality_key: "presencial",
      status: "partial",
    }),
  );
  assert.equal(parsed.success, true);
});

test("partial with both keys null is rejected", () => {
  const parsed = EvaContractV1OutputSchema.safeParse(
    qualificationOutput({
      career_key: null,
      modality_key: null,
      status: "partial",
    }),
  );
  assert.equal(parsed.success, false);
});

test("partial with both keys present is rejected", () => {
  const parsed = EvaContractV1OutputSchema.safeParse(
    qualificationOutput({
      career_key: "derecho",
      modality_key: "presencial",
      status: "partial",
    }),
  );
  assert.equal(parsed.success, false);
});
