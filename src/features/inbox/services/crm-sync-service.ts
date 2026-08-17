import { createClient as createSbClient } from "@supabase/supabase-js";
import { syncContactToHL as defaultSyncContactToHL } from "./highlevel-client";

export type CrmSyncStatus =
  | "missing_contact"
  | "already_synced"
  | "synced"
  | "not_synced";

export interface EnsureLeadInCRMResult {
  status: CrmSyncStatus;
  hlContactId: string | null;
}

export interface CrmContactSnapshot {
  hl_contact_id: string | null;
}

export interface EnsureLeadInCRMDeps {
  loadContact?: (opts: {
    workspaceId: string;
    contactId: string;
  }) => Promise<CrmContactSnapshot | null>;
  syncContactToHL?: (
    workspaceId: string,
    contactId: string,
  ) => Promise<{ hl_id: string } | null>;
  generateWithTools?: () => Promise<unknown>;
  dispatchText?: () => Promise<unknown>;
}

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadCanonicalContact(opts: {
  workspaceId: string;
  contactId: string;
}): Promise<CrmContactSnapshot | null> {
  const supabase = svc();
  const { data, error } = await supabase
    .from("contacts")
    .select("hl_contact_id")
    .eq("workspace_id", opts.workspaceId)
    .eq("id", opts.contactId)
    .maybeSingle();

  if (error) {
    throw new Error(`[crm-sync] contact lookup failed: ${error.message}`);
  }

  if (!data) return null;

  const hlContactId =
    typeof data.hl_contact_id === "string" && data.hl_contact_id.trim()
      ? data.hl_contact_id.trim()
      : null;

  return { hl_contact_id: hlContactId };
}

export async function ensureLeadInCRM(opts: {
  workspaceId: string;
  contactId: string;
  env?: Record<string, string | undefined>;
  deps?: EnsureLeadInCRMDeps;
}): Promise<EnsureLeadInCRMResult> {
  void opts.env;

  const loadContact = opts.deps?.loadContact ?? loadCanonicalContact;
  const syncContactToHL =
    opts.deps?.syncContactToHL ?? defaultSyncContactToHL;

  try {
    const contact = await loadContact({
      workspaceId: opts.workspaceId,
      contactId: opts.contactId,
    });

    if (!contact) {
      console.warn("[crm-sync] canonical contact missing; skipping GHL", {
        workspaceId: opts.workspaceId,
        contactId: opts.contactId,
      });
      return { status: "missing_contact", hlContactId: null };
    }

    if (contact.hl_contact_id) {
      return {
        status: "already_synced",
        hlContactId: contact.hl_contact_id,
      };
    }

    const synced = await syncContactToHL(opts.workspaceId, opts.contactId);
    const hlContactId = synced?.hl_id?.trim() ? synced.hl_id.trim() : null;

    if (!hlContactId) {
      console.warn("[crm-sync] GHL sync skipped or failed; Eva continues", {
        workspaceId: opts.workspaceId,
        contactId: opts.contactId,
      });
      return { status: "not_synced", hlContactId: null };
    }

    return { status: "synced", hlContactId };
  } catch (error) {
    console.error("[crm-sync] fail-safe:", errorMessage(error), {
      workspaceId: opts.workspaceId,
      contactId: opts.contactId,
    });
    return { status: "not_synced", hlContactId: null };
  }
}
