import type { EvaContractV1Output } from "../contracts/eva-contract-v1";

export type PlannedAction =
  | {
      actionType: "handoff.prepare";
      payload: {
        handoff_reason: string;
        reason: string | null;
        note: string | null;
        career_key: string | null;
        modality_key: "presencial" | "en_linea" | null;
        qualification_status: string;
        intent_key: string | null;
      };
    }
  | {
      actionType: "calendar.prepare_booking";
      payload: {
        preferred_date: string | null;
        preferred_time_window: string | null;
        reason: string | null;
        note: string | null;
        intent_key: string | null;
      };
    }
  | {
      actionType: "followup.prepare";
      payload: {
        reason: string | null;
        note: string | null;
        intent_key: string | null;
      };
    }
  | {
      actionType: "qualification.record";
      payload: {
        career_key: string;
        modality_key: "presencial" | "en_linea";
        confidence: number | null;
        intent_key: string | null;
        intent_status: string;
      };
    };

export function planEvaActions(
  output: EvaContractV1Output,
): PlannedAction[] {
  const planned: PlannedAction[] = [];
  const seen = new Set<string>();

  for (const action of output.proposed_actions) {
    if (action.type === "no_action") continue;

    if (seen.has(action.type)) {
      throw new Error(
        `[action-planner] duplicate proposed action: ${action.type}`,
      );
    }
    seen.add(action.type);

    switch (action.type) {
      case "handoff_human": {
        if (!output.handoff.requested || output.handoff.reason === null) {
          throw new Error(
            "[action-planner] handoff action requires a valid handoff request",
          );
        }

        planned.push({
          actionType: "handoff.prepare",
          payload: {
            handoff_reason: output.handoff.reason,
            reason: action.reason,
            note: action.note ?? output.handoff.note,
            career_key: output.qualification.career_key,
            modality_key: output.qualification.modality_key,
            qualification_status: output.qualification.status,
            intent_key: output.intent.key,
          },
        });
        break;
      }

      case "schedule_requested": {
        planned.push({
          actionType: "calendar.prepare_booking",
          payload: {
            preferred_date: action.preferred_date,
            preferred_time_window: action.preferred_time_window,
            reason: action.reason,
            note: action.note,
            intent_key: output.intent.key,
          },
        });
        break;
      }

      case "follow_up_requested": {
        planned.push({
          actionType: "followup.prepare",
          payload: {
            reason: action.reason,
            note: action.note,
            intent_key: output.intent.key,
          },
        });
        break;
      }

      case "qualification_complete": {
        if (
          output.qualification.status !== "known" ||
          output.qualification.career_key === null ||
          output.qualification.modality_key === null
        ) {
          throw new Error(
            "[action-planner] qualification_complete requires known canonical qualification",
          );
        }

        planned.push({
          actionType: "qualification.record",
          payload: {
            career_key: output.qualification.career_key,
            modality_key: output.qualification.modality_key,
            confidence: output.qualification.confidence,
            intent_key: output.intent.key,
            intent_status: output.intent.status,
          },
        });
        break;
      }
    }
  }

  return planned;
}
