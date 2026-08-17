import { createClient as createSbClient } from "@supabase/supabase-js";
import { sha256Canonical } from "./canonical-hash";
import { validateControlPlaneAction } from "./action-catalog";
import {
  EVA_CONTRACT_VERSION,
  EvaContractV1OutputSchema,
} from "../contracts/eva-contract-v1";
import { planEvaActions } from "./action-planner";
import {
  resolveActionPolicy,
  type ActionPolicyMode,
} from "./action-policy";

export type { ActionPolicyMode } from "./action-policy";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export type ActionOutboxStatus =
  | "proposed"
  | "draft"
  | "blocked"
  | "pending_approval"
  | "approved"
  | "executing"
  | "succeeded"
  | "failed"
  | "rejected"
  | "cancelled";

export interface ActionOutboxRow {
  id: string;
  workspace_id: string;
  conversation_id: string | null;
  contact_id: string | null;
  agent_run_id: string | null;
  action_type: string;
  payload: Record<string, unknown>;
  payload_hash: string;
  policy_mode: ActionPolicyMode;
  policy_revision: number | null;
  status: ActionOutboxStatus;
  idempotency_key: string;
  attempt_count: number;
  next_attempt_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  executed_at: string | null;
  external_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export function initialStatusForPolicy(
  policyMode: ActionPolicyMode,
): ActionOutboxStatus {
  switch (policyMode) {
    case "disabled":
      return "blocked";
    case "draft":
      return "draft";
    case "approval":
      return "pending_approval";
    case "automatic":
      return "approved";
  }
}

export async function proposeAction(opts: {
  workspaceId: string;
  agentRunId: string;
  actionType: string;
  payload: Record<string, unknown>;
}): Promise<{
  action: ActionOutboxRow;
  created: boolean;
}> {
  const supabase = svc();

  const { data: run, error: runError } = await supabase
    .from("agent_runs")
    .select("id, workspace_id, conversation_id, contact_id, agent_key, contract_version, input_hash, status, decision_json")
    .eq("workspace_id", opts.workspaceId)
    .eq("id", opts.agentRunId)
    .maybeSingle();

  if (runError) {
    throw new Error(`[action-outbox] run lookup failed: ${runError.message}`);
  }

  if (!run) {
    throw new Error("[action-outbox] agent run not found");
  }

  const validatedAction = validateControlPlaneAction(
    opts.actionType,
    opts.payload,
  );

  const actionType = validatedAction.actionType;
  const payload = validatedAction.payload;

  if (run.agent_key !== "eva" || run.contract_version !== EVA_CONTRACT_VERSION) {
    throw new Error("[action-outbox] agent run is not Eva/eva-v1");
  }

  if (run.status !== "completed") {
    throw new Error("[action-outbox] agent run must be completed");
  }

  const decision = EvaContractV1OutputSchema.safeParse(run.decision_json);
  if (!decision.success) {
    throw new Error(
      `[action-outbox] stored Eva decision is invalid: ${decision.error.message}`,
    );
  }

  const requestedFingerprint = sha256Canonical({
    actionType,
    payload,
  });

  const derivedFromRun = planEvaActions(decision.data).some(
    (candidate) => sha256Canonical(candidate) === requestedFingerprint,
  );

  if (!derivedFromRun) {
    throw new Error(
      "[action-outbox] action is not derived from the completed agent run",
    );
  }

  const policy = await resolveActionPolicy(opts.workspaceId, actionType);

  const payloadHash = sha256Canonical(payload);

  const idempotencyKey = sha256Canonical({
    run_input_hash: run.input_hash,
    action_type: actionType,
    payload_hash: payloadHash,
  });

  const initialStatus = initialStatusForPolicy(policy.policyMode);
  const now = new Date().toISOString();

  const insertRow = {
    workspace_id: opts.workspaceId,
    conversation_id: run.conversation_id ?? null,
    contact_id: run.contact_id ?? null,
    agent_run_id: opts.agentRunId,
    action_type: actionType,
    payload,
    payload_hash: payloadHash,
    policy_mode: policy.policyMode,
    policy_revision: policy.revision,
    status: initialStatus,
    idempotency_key: idempotencyKey,
    approved_at: policy.policyMode === "automatic" ? now : null,
  };

  const { data: inserted, error: insertError } = await supabase
    .from("action_outbox")
    .insert(insertRow)
    .select("*")
    .maybeSingle();

  if (!insertError && inserted) {
    return {
      action: inserted as ActionOutboxRow,
      created: true,
    };
  }

  if (insertError?.code !== "23505") {
    throw new Error(
      `[action-outbox] propose failed: ${insertError?.message ?? "unknown"}`,
    );
  }

  const { data: existing, error: existingError } = await supabase
    .from("action_outbox")
    .select("*")
    .eq("workspace_id", opts.workspaceId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (existingError || !existing) {
    throw new Error(
      `[action-outbox] idempotent lookup failed: ${existingError?.message}`,
    );
  }

  return {
    action: existing as ActionOutboxRow,
    created: false,
  };
}

async function getAction(
  workspaceId: string,
  actionId: string,
): Promise<ActionOutboxRow | null> {
  const supabase = svc();

  const { data, error } = await supabase
    .from("action_outbox")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", actionId)
    .maybeSingle();

  if (error) {
    throw new Error(`[action-outbox] lookup failed: ${error.message}`);
  }

  return data ? (data as ActionOutboxRow) : null;
}

async function assertApproverMembership(
  workspaceId: string,
  userId: string,
): Promise<void> {
  const supabase = svc();

  const { data, error } = await supabase
    .from("memberships")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw new Error(
      `[action-outbox] approver membership lookup failed: ${error.message}`,
    );
  }

  const role = data?.role as string | undefined;

  if (!role || (role !== "admin" && role !== "manager")) {
    throw new Error(
      "[action-outbox] approval requires active admin or manager membership",
    );
  }
}

export async function approveAction(opts: {
  workspaceId: string;
  actionId: string;
  approvedBy: string;
}): Promise<ActionOutboxRow> {
  await assertApproverMembership(opts.workspaceId, opts.approvedBy);

  const supabase = svc();
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("action_outbox")
    .update({
      status: "approved",
      approved_by: opts.approvedBy,
      approved_at: now,
      last_error: null,
    })
    .eq("workspace_id", opts.workspaceId)
    .eq("id", opts.actionId)
    .eq("policy_mode", "approval")
    .eq("status", "pending_approval")
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(`[action-outbox] approve failed: ${error.message}`);
  }

  if (data) return data as ActionOutboxRow;

  const existing = await getAction(opts.workspaceId, opts.actionId);

  if (
    existing?.status === "approved" &&
    existing.approved_by === opts.approvedBy
  ) {
    return existing;
  }

  throw new Error(
    "[action-outbox] approve rejected: invalid state, policy, or action",
  );
}

export async function rejectAction(opts: {
  workspaceId: string;
  actionId: string;
  rejectedBy: string;
}): Promise<ActionOutboxRow> {
  await assertApproverMembership(opts.workspaceId, opts.rejectedBy);

  const supabase = svc();

  const { data, error } = await supabase
    .from("action_outbox")
    .update({
      status: "rejected",
      last_error: null,
    })
    .eq("workspace_id", opts.workspaceId)
    .eq("id", opts.actionId)
    .eq("policy_mode", "approval")
    .eq("status", "pending_approval")
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(`[action-outbox] reject failed: ${error.message}`);
  }

  if (data) return data as ActionOutboxRow;

  const existing = await getAction(opts.workspaceId, opts.actionId);
  if (existing?.status === "rejected") return existing;

  throw new Error(
    "[action-outbox] reject rejected: invalid state, policy, or action",
  );
}

export async function markActionExecuting(opts: {
  workspaceId: string;
  actionId: string;
}): Promise<{
  action: ActionOutboxRow;
  claimed: boolean;
}> {
  const current = await getAction(opts.workspaceId, opts.actionId);

  if (!current) {
    throw new Error("[action-outbox] action not found");
  }

  if (current.status !== "approved") {
    return { action: current, claimed: false };
  }

  const supabase = svc();

  const { data, error } = await supabase
    .from("action_outbox")
    .update({
      status: "executing",
      attempt_count: current.attempt_count + 1,
      last_error: null,
      next_attempt_at: null,
    })
    .eq("workspace_id", opts.workspaceId)
    .eq("id", opts.actionId)
    .eq("status", "approved")
    .eq("attempt_count", current.attempt_count)
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(`[action-outbox] claim failed: ${error.message}`);
  }

  if (data) {
    return {
      action: data as ActionOutboxRow,
      claimed: true,
    };
  }

  const latest = await getAction(opts.workspaceId, opts.actionId);

  if (!latest) {
    throw new Error("[action-outbox] action disappeared during claim");
  }

  return { action: latest, claimed: false };
}

export async function markActionSucceeded(opts: {
  workspaceId: string;
  actionId: string;
  externalId?: string | null;
}): Promise<ActionOutboxRow> {
  const supabase = svc();

  const { data, error } = await supabase
    .from("action_outbox")
    .update({
      status: "succeeded",
      external_id: opts.externalId ?? null,
      executed_at: new Date().toISOString(),
      last_error: null,
      next_attempt_at: null,
    })
    .eq("workspace_id", opts.workspaceId)
    .eq("id", opts.actionId)
    .eq("status", "executing")
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(`[action-outbox] succeed failed: ${error.message}`);
  }

  if (data) return data as ActionOutboxRow;

  const existing = await getAction(opts.workspaceId, opts.actionId);
  if (existing?.status === "succeeded") return existing;

  throw new Error(
    "[action-outbox] succeed rejected: action is not executing",
  );
}

export async function markActionFailed(opts: {
  workspaceId: string;
  actionId: string;
  error: string;
  nextAttemptAt?: string | null;
}): Promise<ActionOutboxRow> {
  const supabase = svc();

  const { data, error } = await supabase
    .from("action_outbox")
    .update({
      status: "failed",
      last_error: opts.error.slice(0, 4000),
      next_attempt_at: opts.nextAttemptAt ?? null,
    })
    .eq("workspace_id", opts.workspaceId)
    .eq("id", opts.actionId)
    .eq("status", "executing")
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(`[action-outbox] fail failed: ${error.message}`);
  }

  if (data) return data as ActionOutboxRow;

  const existing = await getAction(opts.workspaceId, opts.actionId);
  if (existing?.status === "failed") return existing;

  throw new Error(
    "[action-outbox] fail rejected: action is not executing",
  );
}
