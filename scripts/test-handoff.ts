// Quick unit test for handoffTriggerReason (run: npx tsx scripts/test-handoff.mjs)
import { handoffTriggerReason } from "../src/features/inbox/services/state-machine";

const cases: [string, "explicit_request" | "frustration" | null][] = [
  // [text, expected reason]
  // ── explicit ES ──
  ["Quiero hablar con alguien por favor", "explicit_request"],
  ["puedo hablar con una persona?", "explicit_request"],
  ["NECESITO UN AGENTE YA", "explicit_request"],
  ["pásame con un asesor", "explicit_request"],
  ["comunícame con un humano", "explicit_request"],
  ["que me atienda una persona", "explicit_request"],
  ["no quiero hablar con un bot", "explicit_request"],
  ["prefiero que me atienda alguien", "explicit_request"],
  // ── explicit EN ──
  ["can I talk to a human?", "explicit_request"],
  ["I want to speak with an agent", "explicit_request"],
  ["transfer me please", "explicit_request"],
  ["i need a real person", "explicit_request"],
  ["live agent please", "explicit_request"],
  // ── frustration ES ──
  ["no me entiendes, ya te dije que es para mañana", "frustration"],
  ["esto no sirve", "frustration"],
  ["este bot no funciona", "frustration"],
  ["estoy harta de repetir lo mismo", "frustration"],
  ["pésimo servicio la verdad", "frustration"],
  ["voy a poner una queja", "frustration"],
  // ── frustration EN ──
  ["you're not helping at all", "frustration"],
  ["this is ridiculous", "frustration"],
  ["i already told you my order number", "frustration"],
  ["worst service ever", "frustration"],
  // ── must NOT trigger (former false positives / normal traffic) ──
  ["¿tienen agente de seguros disponible?", null],
  ["busco un agente de viajes para Cancún", null],
  ["mi lavadora no funciona, ¿la reparan?", null],
  ["el pago no funciona en mi tarjeta", null],
  ["¿cuál es el horario de atención?", null],
  ["hola, quiero información de precios", null],
  ["quiero agendar una cita", null],
  ["what are your prices?", null],
  ["my order hasn't arrived yet", null],
  ["quiero cancelar mi pedido", null], // negocio decide, no auto-handoff
];

let failed = 0;
for (const [text, expected] of cases) {
  const got = handoffTriggerReason(text);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  [${got ?? "null"}]  "${text}"`);
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
