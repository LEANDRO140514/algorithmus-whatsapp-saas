// F3-T1: State machine for conversation states.
// Pure functions only — no async, no DB imports.

export type ConversationState =
  | "ai_active"
  | "human_active"
  | "handoff_pending"
  | "waiting_reply"
  | "paused"
  | "closed";

// Valid transitions: from → allowed next states
const TRANSITIONS: Record<ConversationState, ConversationState[]> = {
  ai_active: [
    "human_active",
    "handoff_pending",
    "waiting_reply",
    "paused",
    "closed",
  ],
  handoff_pending: ["human_active", "ai_active", "closed"],
  human_active: ["ai_active", "waiting_reply", "paused", "closed"],
  waiting_reply: ["ai_active", "human_active", "closed"],
  paused: ["ai_active", "human_active", "closed"],
  closed: [], // terminal
};

export class TransitionError extends Error {
  constructor(from: ConversationState, to: ConversationState) {
    super(`Invalid transition: ${from} → ${to}`);
    this.name = "TransitionError";
  }
}

/**
 * Returns true when the transition from → to is defined in TRANSITIONS.
 */
export function canTransition(
  from: ConversationState,
  to: ConversationState,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Validates that from → to is a legal transition and returns the new state.
 * Throws TransitionError if the transition is not allowed.
 */
export function transition(
  from: ConversationState,
  to: ConversationState,
): ConversationState {
  if (!canTransition(from, to)) {
    throw new TransitionError(from, to);
  }
  return to;
}

/**
 * Returns true only when the AI should generate a reply.
 * Currently only ai_active state permits AI responses.
 */
export function aiShouldRespond(state: ConversationState): boolean {
  return state === "ai_active";
}

// Handoff detection: two tiers, Spanish + English.
// Patterns run against normalized text (lowercase, accents stripped), so they
// are written WITHOUT accents. Bare nouns like "agente"/"operador" are NOT
// matched alone (false positives: "agente de seguros", "agente de viajes") —
// they require an intent verb or qualifier.

// Tier 1 — explicit request for a human.
const EXPLICIT_PATTERNS: RegExp[] = [
  // Spanish
  /\bhablar con\b/,
  /\bcon (una persona|un humano|alguien real)\b/,
  /\b(agente|asesor|soporte|operador|persona) human[oa]\b/,
  /\bpersona real\b/,
  /\batiend[ae]\s+(un|una)\s+(humano|persona|agente|asesor)\b/,
  /\b(quiero|necesito|deseo|prefiero|pasame|comunicame|transfiereme|conectame)\b[^.!?]{0,40}\b(humano|persona|asesor|agente|operador|representante|ejecutivo|alguien)\b/,
  /\bno quiero (hablar|tratar) con (un |una )?(bot|robot|maquina|ia)\b/,
  // English
  /\b(talk|speak|chat) (to|with) (a |an )?(human|person|agent|someone|somebody|real person)\b/,
  /\b(human|live|real) (agent|person|representative|support)\b/,
  /\b(transfer|connect) me\b/,
  /\bi (want|need) (a |an )?(human|person|agent|someone)\b/,
];

// Tier 2 — frustration signals directed at the service/bot.
// Deliberately narrow: "no funciona" alone is a customer describing THEIR
// product problem, not anger at the bot — it must reference the chat/bot/service.
const FRUSTRATION_PATTERNS: RegExp[] = [
  // Spanish
  /\bno me (entiendes|entendiste|estas entendiendo)\b/,
  /\bno me (ayudas|estas ayudando)\b/,
  /\b(este (chat|bot)|esto) no (sirve|funciona|ayuda)\b/,
  /\bya te (dije|lo dije|explique|lo explique)\b/,
  /\bestoy (hart[oa]|molest[oa]|enojad[oa]|furios[oa]|desesperad[oa])\b/,
  /\b(pesimo|terrible|mal|malisimo) servicio\b/,
  /\bes el colmo\b/,
  /\b(poner|levantar|presentar|hacer) una queja\b/,
  /\bvoy a (reportar|denunciar)(los|lo|la)?\b/,
  /\b(pinche|maldito|estupido) (bot|chat|robot|servicio)\b/,
  // English
  /\byou('re| are)? not helping\b/,
  /\byou don'?t understand\b/,
  /\bthis is (useless|ridiculous|unacceptable|frustrating)\b/,
  /\bi already (told|said|explained)\b/,
  /\b(worst|terrible|horrible|awful) service\b/,
  /\bfile a complaint\b/,
];

export type HandoffTriggerReason = "explicit_request" | "frustration";

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "");
}

/**
 * Returns WHY the message triggers a handoff, or null if it doesn't.
 * "explicit_request" = the contact asked for a human.
 * "frustration"     = the contact shows frustration with the bot/service.
 * Accent-insensitive and case-insensitive.
 */
export function handoffTriggerReason(
  text: string,
): HandoffTriggerReason | null {
  const normalized = normalizeText(text);
  if (EXPLICIT_PATTERNS.some((p) => p.test(normalized))) {
    return "explicit_request";
  }
  if (FRUSTRATION_PATTERNS.some((p) => p.test(normalized))) {
    return "frustration";
  }
  return null;
}

/**
 * Returns true when the message text signals the contact should be
 * handed to a human (explicit request or frustration).
 */
export function detectsHandoffTrigger(text: string): boolean {
  return handoffTriggerReason(text) !== null;
}
