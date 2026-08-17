import { createClient as createSbClient } from "@supabase/supabase-js";
import {
  EVA_CONTRACT_VERSION,
  EvaContractV1OutputSchema,
} from "../contracts/eva-contract-v1";
import { planEvaActions } from "./action-planner";
import {
  proposeAction,
  type ActionOutboxRow,
} from "./action-outbox";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export interface PlanAndProposeResult {
  agentRunId: string;
  plannedCount: number;
  actions: Array<{
    action: ActionOutboxRow;
    created: boolean;
  }>;
}

export async function planAndProposeEvaActions(opts: {
  workspaceId: string;
  agentRunId: string;
}): Promise<PlanAndProposeResult> {
  const supabase = svc();

  const { data: run, error } = await supabase
    .from("agent_runs")
    .select("id, agent_key, contract_version, status, decision_json")
    .eq("workspace_id", opts.workspaceId)
    .eq("id", opts.agentRunId)
    .maybeSingle();

  if (error) {
    throw new Error(
      `[action-orchestrator] run lookup failed: ${error.message}`,
    );
  }

  if (!run) {
    throw new Error("[action-orchestrator] agent run not found");
  }

  if (
    run.agent_key !== "eva" ||
    run.contract_version !== EVA_CONTRACT_VERSION
  ) {
    throw new Error(
      "[action-orchestrator] agent run is not Eva/eva-v1",
    );
  }

  if (run.status !== "completed") {
    throw new Error(
      "[action-orchestrator] agent run must be completed",
    );
  }

  const decision = EvaContractV1OutputSchema.safeParse(
    run.decision_json,
  );

  if (!decision.success) {
    throw new Error(
      `[action-orchestrator] stored Eva decision is invalid: ${decision.error.message}`,
    );
  }

  const planned = planEvaActions(decision.data);
  const actions: PlanAndProposeResult["actions"] = [];

  // Sequential on purpose:
  // if a later proposal fails, already-created rows remain safe and a retry
  // resumes through action_outbox idempotency rather than duplicating them.
  for (const plannedAction of planned) {
    const proposed = await proposeAction({
      workspaceId: opts.workspaceId,
      agentRunId: opts.agentRunId,
      actionType: plannedAction.actionType,
      payload: plannedAction.payload,
    });

    actions.push(proposed);
  }

  return {
    agentRunId: opts.agentRunId,
    plannedCount: planned.length,
    actions,
  };
}
