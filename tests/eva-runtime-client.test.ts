import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildEvaRuntimeEnvelope,
  invokeEvaRuntime,
} from "../src/features/agents/services/eva-runtime-client.ts";
import {
  EvaContractV1InputSchema,
  EvaContractV1OutputSchema,
} from "../src/features/agents/contracts/eva-contract-v1.ts";

const workspaceId = "c34a31ca-2354-4c12-aa5d-79876eff280d";
const conversationId = "11111111-2222-4333-8444-555555555555";
const contactId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function validInput() {
  return {
    contract_version: "eva-v1" as const,
    workspace_id: workspaceId,
    conversation_id: conversationId,
    contact: { contact_id: contactId, name: "Ana" },
    recent_messages: [
      {
        role: "user" as const,
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
  };
}

function validOutput() {
  return {
    contract_version: "eva-v1",
    reply: "Hola, soy Eva.",
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
    memory_updates: [],
    proposed_actions: [
      {
        type: "no_action",
        reason: null,
        preferred_date: null,
        preferred_time_window: null,
        note: null,
      },
    ],
  };
}

test("envelope keeps phone only in runtime_context", () => {
  const contract = validInput();
  const envelope = buildEvaRuntimeEnvelope(contract, {
    normalized_phone: "+529999999999",
  });

  assert.equal(envelope.runtime_context.mode, "shadow");
  assert.equal(envelope.runtime_context.normalized_phone, "+529999999999");
  assert.equal("phone" in envelope.contract.contact, false);
  assert.equal("normalized_phone" in envelope.contract, false);
  assert.equal("phone" in envelope.contract, false);
  assert.equal(EvaContractV1InputSchema.safeParse(envelope.contract).success, true);
  assert.equal(JSON.stringify(envelope.contract).includes("+529999999999"), false);
});

test("bridge sends Bearer auth and posts the exact envelope", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(validOutput()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await invokeEvaRuntime({
    contract: validInput(),
    normalizedPhone: "+529999999999",
    env: {
      EVA_RUNTIME_URL: "https://eva.example/v1/turn",
      EVA_RUNTIME_TOKEN: "test-token",
    },
    fetchFn,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://eva.example/v1/turn");
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("authorization"), "Bearer test-token");
  assert.equal(headers.get("content-type"), "application/json");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.runtime_context.mode, "shadow");
  assert.equal(body.runtime_context.normalized_phone, "+529999999999");
  assert.equal(EvaContractV1OutputSchema.safeParse(result).success, true);
});

test("invalid output fail closed without throwing network", async () => {
  const fetchFn = async () =>
    new Response(JSON.stringify({ reply: "bad" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  await assert.rejects(
    () =>
      invokeEvaRuntime({
        contract: validInput(),
        normalizedPhone: "+529999999999",
        env: {
          EVA_RUNTIME_URL: "https://eva.example/v1/turn",
          EVA_RUNTIME_TOKEN: "test-token",
        },
        fetchFn,
      }),
    /fail closed|invalid Eva/i,
  );
});

test("non-2xx response fail closed", async () => {
  const fetchFn = async () =>
    new Response("nope", { status: 500 });

  await assert.rejects(
    () =>
      invokeEvaRuntime({
        contract: validInput(),
        normalizedPhone: "+529999999999",
        env: {
          EVA_RUNTIME_URL: "https://eva.example/v1/turn",
          EVA_RUNTIME_TOKEN: "test-token",
        },
        fetchFn,
      }),
    /fail closed/i,
  );
});

test("missing runtime config fail closed before fetch", async () => {
  let fetched = false;
  const fetchFn = async () => {
    fetched = true;
    return new Response("{}", { status: 200 });
  };

  await assert.rejects(
    () =>
      invokeEvaRuntime({
        contract: validInput(),
        normalizedPhone: "+529999999999",
        env: {},
        fetchFn,
      }),
    /fail closed/i,
  );
  assert.equal(fetched, false);
});
