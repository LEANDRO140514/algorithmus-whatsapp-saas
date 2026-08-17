import type { EvaMemoryUpdate } from "@/features/agents/contracts/eva-contract-v1";
import type { ClientMemoryPatch } from "./client-memory";

export interface MemoryProposalResult {
  patch: ClientMemoryPatch;
  appliedUpdates: number;
}

/**
 * Converts already-validated Eva memory proposals into the canonical
 * ClientMemoryPatch understood by Algorithmus Client Memory.
 *
 * This function performs no database writes.
 */
export function buildClientMemoryPatch(
  updates: EvaMemoryUpdate[],
): MemoryProposalResult {
  const businessState: Record<string, unknown> = {};
  const relationshipFacts: Record<string, unknown> = {};
  let relationshipSummary: string | undefined;

  const seen = new Set<string>();

  for (const update of updates) {
    const identity = `${update.section}:${update.key ?? "__summary__"}`;

    if (seen.has(identity)) {
      throw new Error(
        `[eva-memory-adapter] duplicate memory proposal: ${identity}`,
      );
    }
    seen.add(identity);

    if (update.section === "business_state") {
      if (update.key === null) {
        throw new Error(
          "[eva-memory-adapter] business_state update requires key",
        );
      }
      businessState[update.key] = update.value;
      continue;
    }

    if (update.section === "relationship_facts") {
      if (update.key === null) {
        throw new Error(
          "[eva-memory-adapter] relationship_facts update requires key",
        );
      }
      relationshipFacts[update.key] = update.value;
      continue;
    }

    if (update.section === "relationship_summary") {
      if (typeof update.value !== "string") {
        throw new Error(
          "[eva-memory-adapter] relationship_summary must be string",
        );
      }
      relationshipSummary = update.value.trim();
    }
  }

  const patch: ClientMemoryPatch = {};

  if (Object.keys(businessState).length > 0) {
    patch.businessState = businessState;
  }

  if (Object.keys(relationshipFacts).length > 0) {
    patch.relationshipFacts = relationshipFacts;
  }

  if (relationshipSummary !== undefined) {
    patch.relationshipSummary = relationshipSummary;
  }

  return {
    patch,
    appliedUpdates: updates.length,
  };
}
