// Algorithmus Client Memory v1 — durable, tenant-scoped memory for agent verticals.

import { createClient as createSbClient } from "@supabase/supabase-js";
import { redactSensitivePayload } from "./observability";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export interface ClientMemoryRow {
  id: string;
  workspace_id: string;
  contact_id: string;
  schema_version: string;
  business_state: Record<string, unknown>;
  relationship_summary: string;
  relationship_facts: Record<string, unknown>;
  memory_revision: number;
  last_compacted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientMemoryPatch {
  businessState?: Record<string, unknown>;
  relationshipFacts?: Record<string, unknown>;
  relationshipSummary?: string;
}

export interface ClientMemoryEvent {
  id: string;
  type: string;
  level: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface ClientMemoryBundle {
  memory: ClientMemoryRow;
  recentEvents: ClientMemoryEvent[];
}

export type ClientMemoryUpdateResult =
  | {
      status: "updated";
      memory: ClientMemoryRow;
      changedSections: string[];
      eventRecorded: boolean;
    }
  | {
      status: "unchanged";
      memory: ClientMemoryRow;
      changedSections: [];
      eventRecorded: false;
    }
  | {
      status: "conflict";
      memory: ClientMemoryRow;
      expectedRevision: number;
      actualRevision: number;
    };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function validatePatch(patch: ClientMemoryPatch): void {
  if (patch.businessState !== undefined && !isPlainRecord(patch.businessState)) {
    throw new Error("[client-memory] businessState must be an object");
  }

  if (
    patch.relationshipFacts !== undefined &&
    !isPlainRecord(patch.relationshipFacts)
  ) {
    throw new Error("[client-memory] relationshipFacts must be an object");
  }

  if (
    patch.relationshipSummary !== undefined &&
    typeof patch.relationshipSummary !== "string"
  ) {
    throw new Error("[client-memory] relationshipSummary must be a string");
  }
}

export async function getClientMemory(
  workspaceId: string,
  contactId: string,
): Promise<ClientMemoryRow | null> {
  const supabase = svc();
  const { data, error } = await supabase
    .from("client_memory")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("contact_id", contactId)
    .maybeSingle();

  if (error) {
    throw new Error(`[client-memory] read failed: ${error.message}`);
  }

  return data ? (data as ClientMemoryRow) : null;
}

export async function ensureClientMemory(
  workspaceId: string,
  contactId: string,
): Promise<ClientMemoryRow> {
  const existing = await getClientMemory(workspaceId, contactId);
  if (existing) return existing;

  const supabase = svc();
  const { error } = await supabase.from("client_memory").upsert(
    {
      workspace_id: workspaceId,
      contact_id: contactId,
    },
    {
      onConflict: "workspace_id,contact_id",
      ignoreDuplicates: true,
    },
  );

  if (error) {
    throw new Error(`[client-memory] ensure failed: ${error.message}`);
  }

  const created = await getClientMemory(workspaceId, contactId);
  if (!created) {
    throw new Error("[client-memory] memory row missing after ensure");
  }

  return created;
}

export async function getRecentClientEvents(
  workspaceId: string,
  contactId: string,
  limit = 12,
): Promise<ClientMemoryEvent[]> {
  const supabase = svc();
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 50);

  const { data, error } = await supabase
    .from("events")
    .select("id, type, level, payload, created_at")
    .eq("workspace_id", workspaceId)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (error) {
    throw new Error(`[client-memory] event read failed: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    id: row.id as string,
    type: row.type as string,
    level: (row.level as string) ?? "info",
    payload: redactSensitivePayload(
      (row.payload ?? {}) as Record<string, unknown>,
    ),
    created_at: row.created_at as string,
  }));
}

export async function getClientMemoryBundle(opts: {
  workspaceId: string;
  contactId: string;
  eventLimit?: number;
}): Promise<ClientMemoryBundle> {
  const memory = await ensureClientMemory(opts.workspaceId, opts.contactId);
  const recentEvents = await getRecentClientEvents(
    opts.workspaceId,
    opts.contactId,
    opts.eventLimit ?? 12,
  );

  return { memory, recentEvents };
}

export async function recordMemoryEvent(opts: {
  workspaceId: string;
  contactId: string;
  conversationId?: string | null;
  type: string;
  level?: "debug" | "info" | "warn" | "error";
  payload?: Record<string, unknown>;
}): Promise<boolean> {
  const supabase = svc();
  const { error } = await supabase.from("events").insert({
    workspace_id: opts.workspaceId,
    contact_id: opts.contactId,
    conversation_id: opts.conversationId ?? null,
    type: opts.type,
    level: opts.level ?? "info",
    payload: opts.payload ?? {},
  });

  if (error) {
    console.error("[client-memory] event insert failed:", error.message);
    return false;
  }

  return true;
}

export async function updateClientMemory(opts: {
  workspaceId: string;
  contactId: string;
  expectedRevision: number;
  patch: ClientMemoryPatch;
  conversationId?: string | null;
  agentRunId?: string | null;
  source?: string;
}): Promise<ClientMemoryUpdateResult> {
  validatePatch(opts.patch);

  const current = await ensureClientMemory(opts.workspaceId, opts.contactId);

  if (current.memory_revision !== opts.expectedRevision) {
    return {
      status: "conflict",
      memory: current,
      expectedRevision: opts.expectedRevision,
      actualRevision: current.memory_revision,
    };
  }

  const update: Record<string, unknown> = {};
  const changedSections: string[] = [];

  if (opts.patch.businessState !== undefined) {
    update.business_state = {
      ...current.business_state,
      ...opts.patch.businessState,
    };
    changedSections.push("business_state");
  }

  if (opts.patch.relationshipFacts !== undefined) {
    update.relationship_facts = {
      ...current.relationship_facts,
      ...opts.patch.relationshipFacts,
    };
    changedSections.push("relationship_facts");
  }

  if (opts.patch.relationshipSummary !== undefined) {
    update.relationship_summary = opts.patch.relationshipSummary.trim();
    changedSections.push("relationship_summary");
  }

  if (changedSections.length === 0) {
    return {
      status: "unchanged",
      memory: current,
      changedSections: [],
      eventRecorded: false,
    };
  }

  const supabase = svc();
  const { data, error } = await supabase.rpc("apply_client_memory_patch", {
    p_workspace_id: opts.workspaceId,
    p_contact_id: opts.contactId,
    p_expected_revision: opts.expectedRevision,
    p_business_state_patch: opts.patch.businessState ?? null,
    p_relationship_facts_patch: opts.patch.relationshipFacts ?? null,
    p_relationship_summary:
      opts.patch.relationshipSummary !== undefined
        ? opts.patch.relationshipSummary.trim()
        : null,
    p_conversation_id: opts.conversationId ?? null,
    p_agent_run_id: opts.agentRunId ?? null,
    p_source: opts.source ?? "control_plane",
  });

  if (error) {
    throw new Error(`[client-memory] atomic update failed: ${error.message}`);
  }

  const row = Array.isArray(data) ? data[0] : data;

  if (!row) {
    const latest = await ensureClientMemory(opts.workspaceId, opts.contactId);
    return {
      status: "conflict",
      memory: latest,
      expectedRevision: opts.expectedRevision,
      actualRevision: latest.memory_revision,
    };
  }

  const memory = row as ClientMemoryRow;

  return {
    status: "updated",
    memory,
    changedSections,
    eventRecorded: true,
  };
}

export function buildMemoryContext(bundle: ClientMemoryBundle): string {
  const { memory, recentEvents } = bundle;
  const parts: string[] = ["## Client Memory"];

  parts.push(`Revision: ${memory.memory_revision}`);

  if (Object.keys(memory.business_state).length > 0) {
    parts.push(
      `Business state:\n${JSON.stringify(memory.business_state, null, 2)}`,
    );
  }

  if (memory.relationship_summary.trim()) {
    parts.push(`Relationship summary:\n${memory.relationship_summary.trim()}`);
  }

  if (Object.keys(memory.relationship_facts).length > 0) {
    parts.push(
      `Relationship facts:\n${JSON.stringify(memory.relationship_facts, null, 2)}`,
    );
  }

  if (recentEvents.length > 0) {
    const eventLines = recentEvents.map(
      (event) =>
        `${event.created_at} | ${event.type} | ${JSON.stringify(event.payload)}`,
    );
    parts.push(`Recent operational events:\n${eventLines.join("\n")}`);
  }

  return parts.join("\n\n");
}
