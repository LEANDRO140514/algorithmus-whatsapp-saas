import { createClient as createSbClient } from "@supabase/supabase-js";
import type { ActiveAgent } from "../types";
import {
  EVA_CONTRACT_VERSION,
  EvaContractV1InputSchema,
  type EvaContractV1Input,
  type EvaContractV1Output,
} from "../contracts/eva-contract-v1";
import {
  completeAgentRun,
  failAgentRun,
  startAgentRun,
} from "./agent-run";
import { planAndProposeEvaActions } from "./action-orchestrator";
import {
  invokeEvaRuntime,
  type InvokeEvaRuntimeOpts,
} from "./eva-runtime-client";
import {
  getClientMemoryBundle,
  updateClientMemory,
  type ClientMemoryBundle,
  type ClientMemoryPatch,
} from "../../inbox/services/client-memory";
import { buildClientMemoryPatch } from "../../inbox/services/eva-memory-adapter";
import type { ConversationTurn } from "../../inbox/services/conversation-history";
import type {
  KbSearchResult,
  KbSourceLink,
} from "../../inbox/services/kb-service";

type EnvMap = Record<string, string | undefined>;

export interface EvaShadowContact {
  name: string | null;
  phone: string;
}

export interface EvaShadowDeps {
  loadContact?: (opts: {
    workspaceId: string;
    contactId: string;
  }) => Promise<EvaShadowContact | null>;
  getMemoryBundle?: (opts: {
    workspaceId: string;
    contactId: string;
  }) => Promise<ClientMemoryBundle>;
  startAgentRun?: (opts: {
    workspaceId: string;
    conversationId: string;
    contactId: string;
    agentKey: string;
    contractVersion: string;
    input: EvaContractV1Input;
    memoryRevision: number;
  }) => Promise<{ id: string }>;
  invokeEvaRuntime?: (
    opts: InvokeEvaRuntimeOpts,
  ) => Promise<EvaContractV1Output>;
  completeAgentRun?: (opts: {
    workspaceId: string;
    runId: string;
    decision: EvaContractV1Output;
  }) => Promise<{ id: string }>;
  failAgentRun?: (opts: {
    workspaceId: string;
    runId: string;
    error: string;
  }) => Promise<{ id: string }>;
  buildMemoryPatch?: typeof buildClientMemoryPatch;
  updateClientMemory?: (opts: {
    workspaceId: string;
    contactId: string;
    expectedRevision: number;
    patch: ClientMemoryPatch;
    conversationId: string;
    agentRunId: string;
    source: string;
  }) => Promise<unknown>;
  planAndProposeEvaActions?: (opts: {
    workspaceId: string;
    agentRunId: string;
  }) => Promise<{ plannedCount: number }>;
  generateWithTools?: () => Promise<unknown>;
  dispatchText?: () => Promise<unknown>;
  createHLOpportunity?: () => Promise<unknown>;
}

export type EvaShadowTurnResult =
  | { handled: false }
  | {
      handled: true;
      status: "completed" | "failed";
      runId?: string;
      output?: EvaContractV1Output;
      error?: string;
    };

function readEnv(env: EnvMap | undefined, key: string): string {
  const value = (env ?? process.env)[key];
  return typeof value === "string" ? value.trim() : "";
}

function isEvaAgent(agent: ActiveAgent | null | undefined): boolean {
  if (!agent) return false;

  const configKey = agent.config.agent_key;
  if (typeof configKey === "string" && configKey.trim().toLowerCase() === "eva") {
    return true;
  }

  return agent.name.trim().toLowerCase() === "eva";
}

export function isEvaShadowEnabled(
  agent: ActiveAgent | null | undefined,
  env: EnvMap = process.env,
): boolean {
  return (
    readEnv(env, "EVA_SHADOW_ENABLED") === "true" &&
    Boolean(readEnv(env, "EVA_RUNTIME_URL")) &&
    Boolean(readEnv(env, "EVA_RUNTIME_TOKEN")) &&
    isEvaAgent(agent)
  );
}

export function buildKnowledgeContext(
  kbResults: KbSearchResult[],
  kbLinks: KbSourceLink[],
): string[] {
  const items: string[] = [];

  for (const result of kbResults) {
    const chunk = result.chunk.trim();
    if (!chunk) continue;
    items.push(`[Fuente: ${result.document_title}]\n${chunk}`);
  }

  for (const link of kbLinks) {
    const title = link.title.trim();
    const url = link.url.trim();
    if (!url) continue;
    items.push(title ? `${title}: ${url}` : url);
  }

  return items.slice(0, 20);
}

function canonicalContactName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildEvaContractInput(opts: {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  contactName: string | null;
  history: ConversationTurn[];
  mergedText: string;
  mergedCreatedAt: string;
  memoryBundle: ClientMemoryBundle;
  kbResults: KbSearchResult[];
  kbLinks: KbSourceLink[];
}): EvaContractV1Input {
  const currentMessage = {
    role: "user" as const,
    content: opts.mergedText,
    created_at: opts.mergedCreatedAt,
  };

  const prior = opts.history.map((turn) => ({
    role: turn.role,
    content: turn.content,
    created_at: turn.created_at,
  }));

  const recent_messages = [...prior, currentMessage].slice(-30);
  const { memory, recentEvents } = opts.memoryBundle;

  const input = {
    contract_version: EVA_CONTRACT_VERSION,
    workspace_id: opts.workspaceId,
    conversation_id: opts.conversationId,
    contact: {
      contact_id: opts.contactId,
      name: canonicalContactName(opts.contactName),
    },
    recent_messages,
    memory: {
      schema_version: memory.schema_version,
      memory_revision: memory.memory_revision,
      business_state: memory.business_state,
      relationship_summary: memory.relationship_summary,
      relationship_facts: memory.relationship_facts,
      recent_events: recentEvents.map((event) => ({
        type: event.type,
        level: event.level,
        payload: event.payload,
        created_at: event.created_at,
      })),
    },
    knowledge_context: buildKnowledgeContext(opts.kbResults, opts.kbLinks),
  };

  const parsed = EvaContractV1InputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `[eva-shadow] fail closed: invalid Eva input: ${parsed.error.message}`,
    );
  }

  return parsed.data;
}

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

async function loadCanonicalContact(opts: {
  workspaceId: string;
  contactId: string;
}): Promise<EvaShadowContact | null> {
  const supabase = svc();
  const { data, error } = await supabase
    .from("contacts")
    .select("name, phone")
    .eq("workspace_id", opts.workspaceId)
    .eq("id", opts.contactId)
    .maybeSingle();

  if (error) {
    throw new Error(`[eva-shadow] contact lookup failed: ${error.message}`);
  }

  if (!data || typeof data.phone !== "string" || !data.phone.trim()) {
    return null;
  }

  return {
    name: canonicalContactName(data.name as string | null),
    phone: data.phone.trim(),
  };
}

function hasMemoryPatch(patch: ClientMemoryPatch): boolean {
  return (
    patch.businessState !== undefined ||
    patch.relationshipFacts !== undefined ||
    patch.relationshipSummary !== undefined
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function maybeRunEvaShadowTurn(opts: {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  mergedText: string;
  mergedCreatedAt: string;
  history: ConversationTurn[];
  kbResults: KbSearchResult[];
  kbLinks: KbSourceLink[];
  agent: ActiveAgent | null;
  env?: EnvMap;
  deps?: EvaShadowDeps;
}): Promise<EvaShadowTurnResult> {
  const env = opts.env ?? process.env;
  if (!isEvaShadowEnabled(opts.agent, env)) {
    return { handled: false };
  }

  const deps = opts.deps ?? {};
  const loadContact = deps.loadContact ?? loadCanonicalContact;
  const getMemoryBundle = deps.getMemoryBundle ?? getClientMemoryBundle;
  const startRun = deps.startAgentRun ?? startAgentRun;
  const invokeRuntime = deps.invokeEvaRuntime ?? invokeEvaRuntime;
  const completeRun = deps.completeAgentRun ?? completeAgentRun;
  const failRun = deps.failAgentRun ?? failAgentRun;
  const buildMemoryPatch = deps.buildMemoryPatch ?? buildClientMemoryPatch;
  const persistMemory = deps.updateClientMemory ?? updateClientMemory;
  const proposeActions =
    deps.planAndProposeEvaActions ?? planAndProposeEvaActions;

  let runId: string | undefined;

  try {
    const contact = await loadContact({
      workspaceId: opts.workspaceId,
      contactId: opts.contactId,
    });

    if (!contact) {
      throw new Error("[eva-shadow] fail closed: canonical contact phone missing");
    }

    const memoryBundle = await getMemoryBundle({
      workspaceId: opts.workspaceId,
      contactId: opts.contactId,
    });

    const contract = buildEvaContractInput({
      workspaceId: opts.workspaceId,
      conversationId: opts.conversationId,
      contactId: opts.contactId,
      contactName: contact.name,
      history: opts.history,
      mergedText: opts.mergedText,
      mergedCreatedAt: opts.mergedCreatedAt,
      memoryBundle,
      kbResults: opts.kbResults,
      kbLinks: opts.kbLinks,
    });

    const run = await startRun({
      workspaceId: opts.workspaceId,
      conversationId: opts.conversationId,
      contactId: opts.contactId,
      agentKey: "eva",
      contractVersion: EVA_CONTRACT_VERSION,
      input: contract,
      memoryRevision: memoryBundle.memory.memory_revision,
    });
    runId = run.id;

    const output = await invokeRuntime({
      contract,
      normalizedPhone: contact.phone,
      env,
    });

    await completeRun({
      workspaceId: opts.workspaceId,
      runId: run.id,
      decision: output,
    });

    try {
      const proposal = buildMemoryPatch(output.memory_updates);
      if (hasMemoryPatch(proposal.patch)) {
        await persistMemory({
          workspaceId: opts.workspaceId,
          contactId: opts.contactId,
          expectedRevision: memoryBundle.memory.memory_revision,
          patch: proposal.patch,
          conversationId: opts.conversationId,
          agentRunId: run.id,
          source: "eva",
        });
      }
    } catch (error) {
      console.error("[eva-shadow] memory update failed:", errorMessage(error));
    }

    try {
      await proposeActions({
        workspaceId: opts.workspaceId,
        agentRunId: run.id,
      });
    } catch (error) {
      console.error(
        "[eva-shadow] action proposal failed:",
        errorMessage(error),
      );
    }

    return {
      handled: true,
      status: "completed",
      runId: run.id,
      output,
    };
  } catch (error) {
    const message = errorMessage(error);
    if (runId) {
      try {
        await failRun({
          workspaceId: opts.workspaceId,
          runId,
          error: message,
        });
      } catch (failError) {
        console.error(
          "[eva-shadow] failAgentRun failed:",
          errorMessage(failError),
        );
      }
    }

    console.error("[eva-shadow] fail closed:", message);
    return {
      handled: true,
      status: "failed",
      runId,
      error: message,
    };
  }
}
