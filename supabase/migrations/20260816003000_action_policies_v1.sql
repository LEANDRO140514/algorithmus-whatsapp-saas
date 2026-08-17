-- ============================================================
-- Algorithmus Action Policies v1
-- Per-workspace autonomy policy for control-plane capabilities.
-- Missing policy = disabled (enforced by application resolver).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.action_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL
    REFERENCES public.workspaces(id) ON DELETE CASCADE,

  action_type TEXT NOT NULL,
  policy_mode TEXT NOT NULL DEFAULT 'disabled'
    CHECK (policy_mode IN ('disabled', 'draft', 'approval', 'automatic')),

  revision INTEGER NOT NULL DEFAULT 1
    CHECK (revision >= 1),

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_action_policies_workspace_action
    UNIQUE (workspace_id, action_type),

  CONSTRAINT ck_action_policies_action_type
    CHECK (
      action_type = trim(action_type)
      AND char_length(action_type) BETWEEN 2 AND 120
      AND action_type ~ '^[a-z][a-z0-9_.-]*$'
    )
);

CREATE INDEX IF NOT EXISTS idx_action_policies_workspace
  ON public.action_policies(workspace_id, action_type);

CREATE OR REPLACE FUNCTION public.bump_action_policy_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    NEW.policy_mode IS DISTINCT FROM OLD.policy_mode
    OR NEW.metadata IS DISTINCT FROM OLD.metadata
    OR NEW.action_type IS DISTINCT FROM OLD.action_type
  THEN
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.revision := OLD.revision;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_action_policies_revision
  ON public.action_policies;

CREATE TRIGGER trg_action_policies_revision
  BEFORE UPDATE ON public.action_policies
  FOR EACH ROW
  EXECUTE FUNCTION public.bump_action_policy_revision();

DROP TRIGGER IF EXISTS trg_action_policies_updated_at
  ON public.action_policies;

CREATE TRIGGER trg_action_policies_updated_at
  BEFORE UPDATE ON public.action_policies
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.action_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "action_policies_select_members"
  ON public.action_policies
  FOR SELECT
  USING (
    workspace_id IN (SELECT public.auth_workspace_ids())
  );

CREATE POLICY "action_policies_manage_admin_manager"
  ON public.action_policies
  FOR ALL
  USING (
    workspace_id IN (SELECT public.auth_workspace_ids())
    AND public.auth_has_role(
      workspace_id,
      ARRAY['admin','manager']::workspace_role[]
    )
  )
  WITH CHECK (
    workspace_id IN (SELECT public.auth_workspace_ids())
    AND public.auth_has_role(
      workspace_id,
      ARRAY['admin','manager']::workspace_role[]
    )
  );

-- Snapshot the exact workspace policy revision used by each governed action.
-- NULL means the fail-closed default was used because no workspace policy existed.
ALTER TABLE public.action_outbox
  ADD COLUMN IF NOT EXISTS policy_revision INTEGER
  CHECK (policy_revision IS NULL OR policy_revision >= 1);

COMMENT ON COLUMN public.action_outbox.policy_revision IS
  'Revision of the explicit workspace action policy used for this action. NULL means missing-policy fail-closed default.';
COMMENT ON TABLE public.action_policies IS
  'Workspace-level autonomy policy for Algorithmus control-plane actions. Missing row is fail-closed/disabled.';

COMMENT ON COLUMN public.action_policies.action_type IS
  'Stable control-plane capability key such as handoff.prepare or calendar.prepare_booking.';

COMMENT ON COLUMN public.action_policies.policy_mode IS
  'disabled, draft, approval, or automatic.';

COMMENT ON COLUMN public.action_policies.revision IS
  'Monotonic revision incremented whenever policy semantics change.';
