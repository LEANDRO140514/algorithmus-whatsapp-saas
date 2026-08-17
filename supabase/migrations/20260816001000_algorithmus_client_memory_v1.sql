-- Algorithmus Client Memory v1
-- Control-plane persistence for durable client memory, agent runs and governed actions.
-- This migration intentionally reuses contacts, conversations, messages and events.

-- ============================================================
-- client_memory
-- One durable memory record per contact inside a workspace.
-- Identity stays in contacts; transcript stays in messages.
-- ============================================================
CREATE TABLE IF NOT EXISTS client_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  schema_version TEXT NOT NULL DEFAULT 'acm-v1',
  business_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  relationship_summary TEXT NOT NULL DEFAULT '',
  relationship_facts JSONB NOT NULL DEFAULT '{}'::jsonb,
  memory_revision BIGINT NOT NULL DEFAULT 1 CHECK (memory_revision >= 1),
  last_compacted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_client_memory_contact UNIQUE (workspace_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_client_memory_workspace
  ON client_memory(workspace_id);
CREATE INDEX IF NOT EXISTS idx_client_memory_business_state
  ON client_memory USING GIN (business_state jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_client_memory_relationship_facts
  ON client_memory USING GIN (relationship_facts jsonb_path_ops);

DROP TRIGGER IF EXISTS trg_client_memory_updated_at ON client_memory;
CREATE TRIGGER trg_client_memory_updated_at
  BEFORE UPDATE ON client_memory
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- agent_runs
-- One persisted reasoning/execution envelope per agent turn.
-- The model does not own these trusted identifiers or versions.
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  agent_key TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('queued','running','completed','failed','cancelled')),
  current_step TEXT,
  input_hash TEXT NOT NULL,
  prompt_version TEXT,
  knowledge_version TEXT,
  routing_version TEXT,
  memory_revision BIGINT,
  decision_json JSONB,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace
  ON agent_runs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation
  ON agent_runs(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status
  ON agent_runs(workspace_id, status, created_at DESC);

DROP TRIGGER IF EXISTS trg_agent_runs_updated_at ON agent_runs;
CREATE TRIGGER trg_agent_runs_updated_at
  BEFORE UPDATE ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- action_outbox
-- Eva proposes effects; Algorithmus governs and executes them.
-- ============================================================
CREATE TABLE IF NOT EXISTS action_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  action_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_hash TEXT NOT NULL,
  policy_mode TEXT NOT NULL
    CHECK (policy_mode IN ('disabled','draft','approval','automatic')),
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','draft','blocked','pending_approval','approved','executing','succeeded','failed','rejected','cancelled')),
  idempotency_key TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  external_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_action_outbox_idempotency UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_action_outbox_pending
  ON action_outbox(workspace_id, status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_action_outbox_run
  ON action_outbox(agent_run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_action_outbox_contact
  ON action_outbox(workspace_id, contact_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_action_outbox_updated_at ON action_outbox;
CREATE TRIGGER trg_action_outbox_updated_at
  BEFORE UPDATE ON action_outbox
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- RLS
-- Runtime writes are control-plane/service operations.
-- No direct authenticated-user write policies are granted in v1.
-- ============================================================
ALTER TABLE client_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_outbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY "client_memory_select"
  ON client_memory FOR SELECT
  USING (workspace_id IN (SELECT auth_workspace_ids()));

CREATE POLICY "agent_runs_select"
  ON agent_runs FOR SELECT
  USING (
    workspace_id IN (SELECT auth_workspace_ids())
    AND auth_has_role(workspace_id, ARRAY['admin','manager']::workspace_role[])
  );

CREATE POLICY "action_outbox_select"
  ON action_outbox FOR SELECT
  USING (
    workspace_id IN (SELECT auth_workspace_ids())
    AND auth_has_role(workspace_id, ARRAY['admin','manager']::workspace_role[])
  );

-- ============================================================
-- Tenant consistency guards
-- Prevent privileged writes from linking rows across workspaces.
-- ============================================================
CREATE OR REPLACE FUNCTION public.enforce_workspace_reference()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  ref_id UUID;
  ref_ok BOOLEAN;
BEGIN
  ref_id := NULLIF(to_jsonb(NEW)->>TG_ARGV[0], '')::uuid;

  IF ref_id IS NULL THEN
    RETURN NEW;
  END IF;

  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %s WHERE id = $1 AND workspace_id = $2)',
    TG_ARGV[1]::regclass
  )
  INTO ref_ok
  USING ref_id, NEW.workspace_id;

  IF NOT ref_ok THEN
    RAISE EXCEPTION '% does not belong to workspace_id', TG_ARGV[0]
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_client_memory_contact_workspace ON public.client_memory;
CREATE TRIGGER trg_client_memory_contact_workspace
  BEFORE INSERT OR UPDATE OF workspace_id, contact_id ON public.client_memory
  FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_reference('contact_id', 'public.contacts');

DROP TRIGGER IF EXISTS trg_agent_runs_contact_workspace ON public.agent_runs;
CREATE TRIGGER trg_agent_runs_contact_workspace
  BEFORE INSERT OR UPDATE OF workspace_id, contact_id ON public.agent_runs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_reference('contact_id', 'public.contacts');

DROP TRIGGER IF EXISTS trg_agent_runs_conversation_workspace ON public.agent_runs;
CREATE TRIGGER trg_agent_runs_conversation_workspace
  BEFORE INSERT OR UPDATE OF workspace_id, conversation_id ON public.agent_runs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_reference('conversation_id', 'public.conversations');

DROP TRIGGER IF EXISTS trg_action_outbox_contact_workspace ON public.action_outbox;
CREATE TRIGGER trg_action_outbox_contact_workspace
  BEFORE INSERT OR UPDATE OF workspace_id, contact_id ON public.action_outbox
  FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_reference('contact_id', 'public.contacts');

DROP TRIGGER IF EXISTS trg_action_outbox_conversation_workspace ON public.action_outbox;
CREATE TRIGGER trg_action_outbox_conversation_workspace
  BEFORE INSERT OR UPDATE OF workspace_id, conversation_id ON public.action_outbox
  FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_reference('conversation_id', 'public.conversations');

DROP TRIGGER IF EXISTS trg_action_outbox_run_workspace ON public.action_outbox;
CREATE TRIGGER trg_action_outbox_run_workspace
  BEFORE INSERT OR UPDATE OF workspace_id, agent_run_id ON public.action_outbox
  FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_reference('agent_run_id', 'public.agent_runs');

-- ============================================================
-- Memory revision
-- Makes the revision server-controlled for optimistic concurrency.
-- ============================================================
CREATE OR REPLACE FUNCTION public.bump_client_memory_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.memory_revision := OLD.memory_revision + 1;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_client_memory_revision ON public.client_memory;
CREATE TRIGGER trg_client_memory_revision
  BEFORE UPDATE ON public.client_memory
  FOR EACH ROW EXECUTE FUNCTION public.bump_client_memory_revision();

-- ============================================================
-- Client-level operational timeline
-- Reuse events as the canonical timeline instead of creating a parallel table.
-- ============================================================
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_events_contact
  ON public.events(workspace_id, contact_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_events_contact_workspace ON public.events;
CREATE TRIGGER trg_events_contact_workspace
  BEFORE INSERT OR UPDATE OF workspace_id, contact_id ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_reference('contact_id', 'public.contacts');

-- ============================================================
-- Contract shape guards
-- Keep canonical JSON containers and critical identifiers well-formed.
-- ============================================================
ALTER TABLE public.client_memory
  ADD CONSTRAINT chk_client_memory_schema_version_nonempty CHECK (btrim(schema_version) <> ''),
  ADD CONSTRAINT chk_client_memory_business_state_object CHECK (jsonb_typeof(business_state) = 'object'),
  ADD CONSTRAINT chk_client_memory_relationship_facts_object CHECK (jsonb_typeof(relationship_facts) = 'object');

ALTER TABLE public.agent_runs
  ADD CONSTRAINT chk_agent_runs_agent_key_nonempty CHECK (btrim(agent_key) <> ''),
  ADD CONSTRAINT chk_agent_runs_contract_version_nonempty CHECK (btrim(contract_version) <> ''),
  ADD CONSTRAINT chk_agent_runs_input_hash_nonempty CHECK (btrim(input_hash) <> ''),
  ADD CONSTRAINT chk_agent_runs_decision_object CHECK (decision_json IS NULL OR jsonb_typeof(decision_json) = 'object');

ALTER TABLE public.action_outbox
  ADD CONSTRAINT chk_action_outbox_action_type_nonempty CHECK (btrim(action_type) <> ''),
  ADD CONSTRAINT chk_action_outbox_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  ADD CONSTRAINT chk_action_outbox_payload_hash_nonempty CHECK (btrim(payload_hash) <> ''),
  ADD CONSTRAINT chk_action_outbox_idempotency_nonempty CHECK (btrim(idempotency_key) <> '');
