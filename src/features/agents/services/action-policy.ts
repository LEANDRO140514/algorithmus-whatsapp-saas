import { createClient as createSbClient } from "@supabase/supabase-js";

export const ACTION_POLICY_MODES = [
  "disabled",
  "draft",
  "approval",
  "automatic",
] as const;

export type ActionPolicyMode = (typeof ACTION_POLICY_MODES)[number];

export interface ActionPolicyResolution {
  workspaceId: string;
  actionType: string;
  policyMode: ActionPolicyMode;
  revision: number | null;
  metadata: Record<string, unknown>;
  source: "workspace" | "default";
}

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

function isPolicyMode(value: unknown): value is ActionPolicyMode {
  return (
    typeof value === "string" &&
    (ACTION_POLICY_MODES as readonly string[]).includes(value)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validateActionType(value: string): string {
  const trimmed = value.trim();

  if (
    trimmed !== value ||
    trimmed.length < 2 ||
    trimmed.length > 120 ||
    !/^[a-z][a-z0-9_.-]*$/.test(trimmed)
  ) {
    throw new Error(`[action-policy] invalid action type: ${value}`);
  }

  return trimmed;
}

export async function resolveActionPolicy(
  workspaceId: string,
  rawActionType: string,
): Promise<ActionPolicyResolution> {
  const actionType = validateActionType(rawActionType);
  const supabase = svc();

  const { data, error } = await supabase
    .from("action_policies")
    .select("policy_mode, revision, metadata")
    .eq("workspace_id", workspaceId)
    .eq("action_type", actionType)
    .maybeSingle();

  if (error) {
    throw new Error(`[action-policy] lookup failed: ${error.message}`);
  }

  // Fail closed. Absence never grants autonomy.
  if (!data) {
    return {
      workspaceId,
      actionType,
      policyMode: "disabled",
      revision: null,
      metadata: {},
      source: "default",
    };
  }

  if (!isPolicyMode(data.policy_mode)) {
    throw new Error("[action-policy] stored policy mode is invalid");
  }

  if (!Number.isInteger(data.revision) || data.revision < 1) {
    throw new Error("[action-policy] stored revision is invalid");
  }

  if (!isPlainObject(data.metadata)) {
    throw new Error("[action-policy] stored metadata is invalid");
  }

  return {
    workspaceId,
    actionType,
    policyMode: data.policy_mode,
    revision: data.revision,
    metadata: data.metadata,
    source: "workspace",
  };
}
