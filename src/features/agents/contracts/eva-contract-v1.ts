import { z } from "zod";

export const EVA_CONTRACT_VERSION = "eva-v1" as const;

const ScalarValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

const EvidenceSchema = z
  .object({
    text: z.string().min(1).max(500),
    source_message_index: z.number().int().nonnegative(),
  })
  .strict();

const IntentSchema = z
  .object({
    key: z.string().min(1).max(80).nullable(),
    status: z.enum(["known", "ambiguous", "unknown"]),
    confidence: z.number().min(0).max(1).nullable(),
    evidence: z.array(EvidenceSchema).max(6),
  })
  .strict();

export const EvaQualificationSchema = z
  .object({
    career_key: z
      .string()
      .regex(/^[a-z0-9_]+$/)
      .nullable(),
    modality_key: z.enum(["presencial", "en_linea"]).nullable(),
    status: z.enum(["known", "partial", "ambiguous", "unknown"]),
    confidence: z.number().min(0).max(1).nullable(),
    evidence: z.array(EvidenceSchema).max(6),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasCareer = value.career_key !== null;
    const hasModality = value.modality_key !== null;

    if (value.status === "known" && (!hasCareer || !hasModality)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "known qualification requires career_key and modality_key",
      });
    }

    if (value.status === "unknown" && (hasCareer || hasModality)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "unknown qualification cannot contain canonical keys",
      });
    }

    if (value.status === "partial" && hasCareer === hasModality) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "partial qualification requires exactly one canonical key",
      });
    }
  });

export const EvaHandoffSchema = z
  .object({
    requested: z.boolean(),
    reason: z
      .enum([
        "explicit_request",
        "frustration",
        "low_confidence",
        "policy",
        "out_of_scope",
        "other",
      ])
      .nullable(),
    note: z.string().max(500).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.requested && value.reason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "handoff reason is required when requested=true",
      });
    }

    if (!value.requested && value.reason !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "handoff reason must be null when requested=false",
      });
    }
  });

export const EvaMemoryUpdateSchema = z
  .object({
    section: z.literal("business_state"),
    key: z.enum([
      "career_key",
      "modality_key",
      "admission_stage",
      "last_intent",
      "last_objection",
      "suggested_next_step",
    ]),
    value: ScalarValueSchema,
    evidence: z.literal(null),
  })
  .strict();

export const EvaProposedActionSchema = z
  .object({
    type: z.enum([
      "handoff_human",
      "schedule_requested",
      "follow_up_requested",
      "qualification_complete",
      "no_action",
    ]),
    reason: z.string().max(500).nullable(),
    preferred_date: z.string().max(50).nullable(),
    preferred_time_window: z.string().max(100).nullable(),
    note: z.string().max(500).nullable(),
  })
  .strict();

export const EvaContractV1OutputSchema = z
  .object({
    contract_version: z.literal(EVA_CONTRACT_VERSION),
    reply: z.string().max(4000),
    intent: IntentSchema,
    qualification: EvaQualificationSchema,
    handoff: EvaHandoffSchema,
    memory_updates: z.array(EvaMemoryUpdateSchema).max(20),
    proposed_actions: z.array(EvaProposedActionSchema).min(1).max(10),
  })
  .strict()
  .superRefine((value, ctx) => {
    const noActionCount = value.proposed_actions.filter(
      (action) => action.type === "no_action",
    ).length;

    if (noActionCount > 0 && value.proposed_actions.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "no_action cannot be combined with another proposed action",
      });
    }

    const proposesHandoff = value.proposed_actions.some(
      (action) => action.type === "handoff_human",
    );

    if (proposesHandoff !== value.handoff.requested) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "handoff flag and handoff_human action must agree",
      });
    }
  });

const EvaInputMessageSchema = z
  .object({
    role: z.enum(["user", "assistant", "human"]),
    content: z.string(),
    created_at: z.string(),
  })
  .strict();

const EvaInputEventSchema = z
  .object({
    type: z.string().min(1),
    level: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
    created_at: z.string(),
  })
  .strict();

export const EvaContractV1InputSchema = z
  .object({
    contract_version: z.literal(EVA_CONTRACT_VERSION),
    workspace_id: z.string().uuid(),
    conversation_id: z.string().uuid(),
    contact: z
      .object({
        contact_id: z.string().uuid(),
        name: z.string().nullable(),
      })
      .strict(),
    recent_messages: z.array(EvaInputMessageSchema).max(30),
    memory: z
      .object({
        schema_version: z.string().min(1),
        memory_revision: z.number().int().positive(),
        business_state: z.record(z.string(), z.unknown()),
        relationship_summary: z.string(),
        relationship_facts: z.record(z.string(), z.unknown()),
        recent_events: z.array(EvaInputEventSchema).max(50),
      })
      .strict(),
    knowledge_context: z.array(z.string()).max(20),
  })
  .strict();

export type EvaContractV1Input = z.infer<typeof EvaContractV1InputSchema>;
export type EvaContractV1Output = z.infer<typeof EvaContractV1OutputSchema>;
export type EvaQualification = z.infer<typeof EvaQualificationSchema>;
export type EvaMemoryUpdate = z.infer<typeof EvaMemoryUpdateSchema>;
export type EvaProposedAction = z.infer<typeof EvaProposedActionSchema>;

export function validateEvaContractV1Output(value: unknown) {
  return EvaContractV1OutputSchema.safeParse(value);
}

export function validateEvaContractV1Input(value: unknown) {
  return EvaContractV1InputSchema.safeParse(value);
}
