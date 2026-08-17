import { createClient as createSbClient } from "@supabase/supabase-js";
import {
  EvaContractV1OutputSchema,
  type EvaContractV1Output,
} from "../contracts/eva-contract-v1";
import { sha256Canonical } from "./canonical-hash";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export type AgentRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentRunRow {
  id: string;
  workspace_id: string;
  conversation_id: string | null;
  contact_id: string | null;
  agent_key: string;
  contract_version: string;
  status: AgentRunStatus;
  current_step: string | null;
  input_hash: string;
  prompt_version: string | null;
  knowledge_version: string | null;
  routing_version: string | null;
  memory_revision: number | null;
  decision_json: Record<string, unknown> | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function startAgentRun(opts: {
  workspaceId: string;
  conversationId?: string | null;
  contactId?: string | null;
  agentKey?: string;
  contractVersion: string;
  input: unknown;
  promptVersion?: string | null;
  knowledgeVersion?: string | null;
  routingVersion?: string | null;
  memoryRevision?: number | null;
}): Promise<AgentRunRow> {
  const supabase = svc();

  const { data, error } = await supabase
    .from("agent_runs")
    .insert({
      workspace_id: opts.workspaceId,
      conversation_id: opts.conversationId ?? null,
      contact_id: opts.contactId ?? null,
      agent_key: opts.agentKey ?? "eva",
      contract_version: opts.contractVersion,
      status: "running",
      current_step: "reasoning",
      input_hash: sha256Canonical(opts.input),
      prompt_version: opts.promptVersion ?? null,
      knowledge_version: opts.knowledgeVersion ?? null,
      routing_version: opts.routingVersion ?? null,
      memory_revision: opts.memoryRevision ?? null,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`[agent-run] start failed: ${error?.message}`);
  }

  return data as AgentRunRow;
}

export async function completeAgentRun(opts: {
  workspaceId: string;
  runId: string;
  decision: EvaContractV1Output;
}): Promise<AgentRunRow> {
  const parsed = EvaContractV1OutputSchema.safeParse(opts.decision);
  if (!parsed.success) {
    throw new Error(
      `[agent-run] invalid Eva contract: ${parsed.error.message}`,
    );
  }

  const supabase = svc();
  const completedAt = new Date().toISOString();

  const { data, error } = await supabase
    .from("agent_runs")
    .update({
      status: "completed",
      current_step: "completed",
      decision_json: parsed.data,
      error: null,
      completed_at: completedAt,
    })
    .eq("workspace_id", opts.workspaceId)
    .eq("id", opts.runId)
    .in("status", ["queued", "running"])
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(`[agent-run] complete failed: ${error.message}`);
  }

  if (!data) {
    throw new Error(
      "[agent-run] complete rejected: run not found or terminal state",
    );
  }

  return data as AgentRunRow;
}

export async function failAgentRun(opts: {
  workspaceId: string;
  runId: string;
  error: string;
  currentStep?: string;
}): Promise<AgentRunRow> {

  const supabase = svc();
  const completedAt = new Date().toISOString();

  const { data, error } = await supabase
    .from("agent_runs")
    .update({
      status: "failed",
      current_step: opts.currentStep ?? "failed",
      error: opts.error.slice(0, 4000),
      completed_at: completedAt,
    })
    .eq("workspace_id", opts.workspaceId)
    .eq("id", opts.runId)
    .in("status", ["queued", "running"])
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(`[agent-run] fail failed: ${error.message}`);
  }

  if (!data) {
    throw new Error(
      "[agent-run] fail rejected: run not found or terminal state",
    );
  }

  return data as AgentRunRow;
}
