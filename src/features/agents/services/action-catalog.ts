import { z } from "zod";

const careerKeySchema = z
  .string()
  .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/);

const handoffPrepareSchema = z
  .object({
    handoff_reason: z.enum([
      "explicit_request",
      "frustration",
      "low_confidence",
      "policy",
      "out_of_scope",
      "other",
    ]),
    reason: z.string().nullable(),
    note: z.string().nullable(),
    career_key: careerKeySchema.nullable(),
    modality_key: z.enum(["presencial", "en_linea"]).nullable(),
    qualification_status: z.enum([
      "known",
      "partial",
      "ambiguous",
      "unknown",
    ]),
    intent_key: z.string().min(1).nullable(),
  })
  .strict();

const calendarPrepareBookingSchema = z
  .object({
    preferred_date: z.string().nullable(),
    preferred_time_window: z.string().nullable(),
    reason: z.string().nullable(),
    note: z.string().nullable(),
    intent_key: z.string().min(1).nullable(),
  })
  .strict();

const followupPrepareSchema = z
  .object({
    reason: z.string().nullable(),
    note: z.string().nullable(),
    intent_key: z.string().min(1).nullable(),
  })
  .strict();

const qualificationRecordSchema = z
  .object({
    career_key: careerKeySchema,
    modality_key: z.enum(["presencial", "en_linea"]),
    confidence: z.number().min(0).max(1).nullable(),
    intent_key: z.string().min(1).nullable(),
    intent_status: z.enum(["known", "ambiguous", "unknown"]),
  })
  .strict();

export const CONTROL_PLANE_ACTION_SCHEMAS = {
  "handoff.prepare": handoffPrepareSchema,
  "calendar.prepare_booking": calendarPrepareBookingSchema,
  "followup.prepare": followupPrepareSchema,
  "qualification.record": qualificationRecordSchema,
} as const;

export type ControlPlaneActionType =
  keyof typeof CONTROL_PLANE_ACTION_SCHEMAS;

export function isControlPlaneActionType(
  value: string,
): value is ControlPlaneActionType {
  return Object.prototype.hasOwnProperty.call(
    CONTROL_PLANE_ACTION_SCHEMAS,
    value,
  );
}

export function validateControlPlaneAction(
  actionType: string,
  payload: unknown,
): {
  actionType: ControlPlaneActionType;
  payload: Record<string, unknown>;
} {
  if (!isControlPlaneActionType(actionType)) {
    throw new Error(
      `[action-catalog] unknown control-plane action: ${actionType}`,
    );
  }

  const parsed = CONTROL_PLANE_ACTION_SCHEMAS[actionType].safeParse(payload);

  if (!parsed.success) {
    throw new Error(
      `[action-catalog] invalid ${actionType} payload: ${parsed.error.message}`,
    );
  }

  return {
    actionType,
    payload: parsed.data as Record<string, unknown>,
  };
}
