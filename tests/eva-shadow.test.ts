import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildEvaContractInput,
  buildKnowledgeContext,
  isEvaShadowEnabled,
  maybeRunEvaShadowTurn,
} from "../src/features/agents/services/eva-shadow.ts";
import { buildClientMemoryPatch } from "../src/features/inbox/services/eva-memory-adapter.ts";
import type { EvaContractV1Output } from "../src/features/agents/contracts/eva-contract-v1.ts";
import type { ActiveAgent } from "../src/features/agents/types/index.ts";

const workspaceId = "c34a31ca-2354-4c12-aa5d-79876eff280d";
const conversationId = "11111111-2222-4333-8444-555555555555";
const contactId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const runId = "99999999-aaaa-4bbb-8ccc-dddddddddddd";

function evaAgent(overrides: Partial<ActiveAgent> = {}): ActiveAgent {
  return {
    id: "agent-eva",
    type: "setter",
    name: "Eva",
    avatarKey: "default",
    model: null,
    promptId: null,
    config: {},
    ...overrides,
  };
}

function localAgent(): ActiveAgent {
  return evaAgent({ id: "agent-local", name: "Setter Movinsa" });
}

function validOutput(overrides: Record<string, unknown> = {}): EvaContractV1Output {
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
  } as EvaContractV1Output;
}

const shadowEnv = {
  EVA_SHADOW_ENABLED: "true",
  EVA_RUNTIME_URL: "https://eva.example/v1/turn",
  EVA_RUNTIME_TOKEN: "test-token",
};

test("gate is off by default and ignores non-Eva agents", () => {
  assert.equal(isEvaShadowEnabled(evaAgent(), {}), false);
  assert.equal(isEvaShadowEnabled(evaAgent(), { EVA_SHADOW_ENABLED: "true" }), false);
  assert.equal(isEvaShadowEnabled(localAgent(), shadowEnv), false);
  assert.equal(isEvaShadowEnabled(null, shadowEnv), false);
  assert.equal(isEvaShadowEnabled(evaAgent(), shadowEnv), true);
});

test("knowledge_context is derived from recovered KB chunks and links", () => {
  const context = buildKnowledgeContext(
    [
      {
        chunk: "No hay examen de admision.",
        document_title: "FAQ",
        document_id: "doc-1",
        similarity: 0.9,
      },
    ],
    [{ title: "Carreras", url: "https://carreras.universidadlatino.edu.mx" }],
  );
  assert.deepEqual(context, [
    "[Fuente: FAQ]\nNo hay examen de admision.",
    "Carreras: https://carreras.universidadlatino.edu.mx",
  ]);
});

test("canonical input uses Console identity and omits phone", () => {
  const input = buildEvaContractInput({
    workspaceId,
    conversationId,
    contactId,
    contactName: "Ana",
    history: [
      {
        role: "assistant",
        content: "Bienvenida",
        created_at: "2026-08-17T00:00:00.000Z",
      },
    ],
    mergedText: "Quiero Derecho",
    mergedCreatedAt: "2026-08-17T00:01:00.000Z",
    memoryBundle: {
      memory: {
        id: "mem-1",
        workspace_id: workspaceId,
        contact_id: contactId,
        schema_version: "client-memory-v1",
        business_state: { career_key: "derecho" },
        relationship_summary: "",
        relationship_facts: {},
        memory_revision: 3,
        last_compacted_at: null,
        created_at: "2026-08-17T00:00:00.000Z",
        updated_at: "2026-08-17T00:00:00.000Z",
      },
      recentEvents: [
        {
          id: "evt-1",
          type: "note",
          level: "info",
          payload: { text: "seguimiento" },
          created_at: "2026-08-16T00:00:00.000Z",
        },
      ],
    },
    kbResults: [
      {
        chunk: "Derecho presencial",
        document_title: "Oferta",
        document_id: "doc-2",
        similarity: 0.8,
      },
    ],
    kbLinks: [],
  });

  assert.equal(input.contract_version, "eva-v1");
  assert.equal(input.workspace_id, workspaceId);
  assert.equal(input.conversation_id, conversationId);
  assert.equal(input.contact.contact_id, contactId);
  assert.equal(input.contact.name, "Ana");
  assert.equal("phone" in input.contact, false);
  assert.equal(input.recent_messages.at(-1)?.role, "user");
  assert.equal(input.recent_messages.at(-1)?.content, "Quiero Derecho");
  assert.equal(input.memory.memory_revision, 3);
  assert.deepEqual(input.knowledge_context, ["[Fuente: Oferta]\nDerecho presencial"]);
});

test("Eva SHADOW completes agent run, memory adapter and planner without local LLM or outbound", async () => {
  const calls: string[] = [];
  const output = validOutput();
  const result = await maybeRunEvaShadowTurn({
    workspaceId,
    conversationId,
    contactId,
    mergedText: "Hola",
    mergedCreatedAt: "2026-08-17T00:01:00.000Z",
    history: [],
    kbResults: [],
    kbLinks: [],
    agent: evaAgent(),
    env: shadowEnv,
    deps: {
      loadContact: async () => {
        calls.push("loadContact");
        return { name: "Ana", phone: "+529999999999" };
      },
      getMemoryBundle: async () => {
        calls.push("getMemoryBundle");
        return {
          memory: {
            id: "mem-1",
            workspace_id: workspaceId,
            contact_id: contactId,
            schema_version: "client-memory-v1",
            business_state: {},
            relationship_summary: "",
            relationship_facts: {},
            memory_revision: 1,
            last_compacted_at: null,
            created_at: "2026-08-17T00:00:00.000Z",
            updated_at: "2026-08-17T00:00:00.000Z",
          },
          recentEvents: [],
        };
      },
      startAgentRun: async (opts) => {
        calls.push("startAgentRun");
        assert.equal(opts.agentKey, "eva");
        assert.equal(opts.contractVersion, "eva-v1");
        assert.equal("normalized_phone" in (opts.input as object), false);
        return { id: runId };
      },
      invokeEvaRuntime: async (opts) => {
        calls.push("invokeEvaRuntime");
        assert.equal(opts.normalizedPhone, "+529999999999");
        return output;
      },
      completeAgentRun: async (opts) => {
        calls.push("completeAgentRun");
        assert.equal(opts.runId, runId);
        assert.equal(opts.decision.reply, output.reply);
        return { id: runId };
      },
      failAgentRun: async () => {
        calls.push("failAgentRun");
        return { id: runId };
      },
      buildMemoryPatch: (updates) => {
        calls.push("buildMemoryPatch");
        return buildClientMemoryPatch(updates);
      },
      updateClientMemory: async (opts) => {
        calls.push("updateClientMemory");
        assert.equal(opts.expectedRevision, 1);
        assert.equal(opts.source, "eva");
        assert.deepEqual(opts.patch.businessState, { last_intent: "saludo" });
        return { status: "updated" };
      },
      planAndProposeEvaActions: async (opts) => {
        calls.push("planAndProposeEvaActions");
        assert.equal(opts.agentRunId, runId);
        return { plannedCount: 0 };
      },
      generateWithTools: async () => {
        calls.push("generateWithTools");
        throw new Error("local LLM must not run in SHADOW");
      },
      dispatchText: async () => {
        calls.push("dispatchText");
        throw new Error("outbound must not run in SHADOW");
      },
      createHLOpportunity: async () => {
        calls.push("createHLOpportunity");
        throw new Error("GHL must not run in SHADOW");
      },
    },
  });

  assert.equal(result.handled, true);
  if (!result.handled) throw new Error("expected handled");
  assert.equal(result.status, "completed");
  assert.equal(calls.includes("generateWithTools"), false);
  assert.equal(calls.includes("dispatchText"), false);
  assert.equal(calls.includes("createHLOpportunity"), false);
  assert.equal(calls.includes("failAgentRun"), false);
  assert.deepEqual(calls, [
    "loadContact",
    "getMemoryBundle",
    "startAgentRun",
    "invokeEvaRuntime",
    "completeAgentRun",
    "buildMemoryPatch",
    "updateClientMemory",
    "planAndProposeEvaActions",
  ]);
});

test("invalid Eva output fail closed and does not fall through to local LLM", async () => {
  const calls: string[] = [];
  const result = await maybeRunEvaShadowTurn({
    workspaceId,
    conversationId,
    contactId,
    mergedText: "Hola",
    mergedCreatedAt: "2026-08-17T00:01:00.000Z",
    history: [],
    kbResults: [],
    kbLinks: [],
    agent: evaAgent(),
    env: shadowEnv,
    deps: {
      loadContact: async () => ({ name: null, phone: "+529999999999" }),
      getMemoryBundle: async () => ({
        memory: {
          id: "mem-1",
          workspace_id: workspaceId,
          contact_id: contactId,
          schema_version: "client-memory-v1",
          business_state: {},
          relationship_summary: "",
          relationship_facts: {},
          memory_revision: 1,
          last_compacted_at: null,
          created_at: "2026-08-17T00:00:00.000Z",
          updated_at: "2026-08-17T00:00:00.000Z",
        },
        recentEvents: [],
      }),
      startAgentRun: async () => {
        calls.push("startAgentRun");
        return { id: runId };
      },
      invokeEvaRuntime: async () => {
        calls.push("invokeEvaRuntime");
        throw new Error("[eva-runtime-client] fail closed: invalid Eva output");
      },
      completeAgentRun: async () => {
        calls.push("completeAgentRun");
        return { id: runId };
      },
      failAgentRun: async (opts) => {
        calls.push("failAgentRun");
        assert.equal(opts.runId, runId);
        return { id: runId };
      },
      generateWithTools: async () => {
        calls.push("generateWithTools");
        throw new Error("must not fall through");
      },
      dispatchText: async () => {
        calls.push("dispatchText");
        throw new Error("must not fall through");
      },
    },
  });

  assert.equal(result.handled, true);
  if (!result.handled) throw new Error("expected handled");
  assert.equal(result.status, "failed");
  assert.equal(calls.includes("completeAgentRun"), false);
  assert.equal(calls.includes("generateWithTools"), false);
  assert.equal(calls.includes("dispatchText"), false);
  assert.deepEqual(calls, ["startAgentRun", "invokeEvaRuntime", "failAgentRun"]);
});

test("non-Eva path is not handled so local buffer behavior is preserved", async () => {
  let shadowStarted = false;
  const result = await maybeRunEvaShadowTurn({
    workspaceId,
    conversationId,
    contactId,
    mergedText: "Hola",
    mergedCreatedAt: "2026-08-17T00:01:00.000Z",
    history: [],
    kbResults: [],
    kbLinks: [],
    agent: localAgent(),
    env: shadowEnv,
    deps: {
      startAgentRun: async () => {
        shadowStarted = true;
        return { id: runId };
      },
    },
  });

  assert.equal(result.handled, false);
  assert.equal(shadowStarted, false);
});
