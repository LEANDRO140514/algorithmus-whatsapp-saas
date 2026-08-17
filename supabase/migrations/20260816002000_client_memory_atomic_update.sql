-- Algorithmus Client Memory v1.1
-- Atomically updates canonical memory and records its audit event.

CREATE OR REPLACE FUNCTION public.apply_client_memory_patch(
  p_workspace_id uuid,
  p_contact_id uuid,
  p_expected_revision bigint,
  p_business_state_patch jsonb DEFAULT NULL,
  p_relationship_facts_patch jsonb DEFAULT NULL,
  p_relationship_summary text DEFAULT NULL,
  p_conversation_id uuid DEFAULT NULL,
  p_agent_run_id uuid DEFAULT NULL,
  p_source text DEFAULT 'control_plane'
)
RETURNS SETOF public.client_memory
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_memory public.client_memory%ROWTYPE;
  v_changed_sections text[] := ARRAY[]::text[];
BEGIN
  IF p_conversation_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.conversations AS c
       WHERE c.id = p_conversation_id
         AND c.workspace_id = p_workspace_id
         AND c.contact_id = p_contact_id
     ) THEN
    RAISE EXCEPTION 'conversation does not belong to memory context'
      USING ERRCODE = '23514';
  END IF;

  IF p_agent_run_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.agent_runs AS ar
       WHERE ar.id = p_agent_run_id
         AND ar.workspace_id = p_workspace_id
         AND (ar.contact_id IS NULL OR ar.contact_id = p_contact_id)
         AND (
           ar.conversation_id IS NULL
           OR ar.conversation_id = p_conversation_id
         )
     ) THEN
    RAISE EXCEPTION 'agent run does not belong to memory context'
      USING ERRCODE = '23514';
  END IF;
  IF p_business_state_patch IS NOT NULL
     AND jsonb_typeof(p_business_state_patch) <> 'object' THEN
    RAISE EXCEPTION 'business_state patch must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  IF p_relationship_facts_patch IS NOT NULL
     AND jsonb_typeof(p_relationship_facts_patch) <> 'object' THEN
    RAISE EXCEPTION 'relationship_facts patch must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  IF p_business_state_patch IS NOT NULL THEN
    v_changed_sections := array_append(v_changed_sections, 'business_state');
  END IF;

  IF p_relationship_facts_patch IS NOT NULL THEN
    v_changed_sections := array_append(v_changed_sections, 'relationship_facts');
  END IF;

  IF p_relationship_summary IS NOT NULL THEN
    v_changed_sections := array_append(v_changed_sections, 'relationship_summary');
  END IF;

  UPDATE public.client_memory AS cm
  SET
    business_state = CASE
      WHEN p_business_state_patch IS NULL THEN cm.business_state
      ELSE cm.business_state || p_business_state_patch
    END,
    relationship_facts = CASE
      WHEN p_relationship_facts_patch IS NULL THEN cm.relationship_facts
      ELSE cm.relationship_facts || p_relationship_facts_patch
    END,
    relationship_summary = CASE
      WHEN p_relationship_summary IS NULL THEN cm.relationship_summary
      ELSE p_relationship_summary
    END
  WHERE cm.workspace_id = p_workspace_id
    AND cm.contact_id = p_contact_id
    AND cm.memory_revision = p_expected_revision
  RETURNING cm.* INTO v_memory;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO public.events (
    workspace_id,
    contact_id,
    conversation_id,
    type,
    level,
    payload
  )
  VALUES (
    p_workspace_id,
    p_contact_id,
    p_conversation_id,
    'client_memory_updated',
    'info',
    jsonb_build_object(
      'previous_revision', p_expected_revision,
      'memory_revision', v_memory.memory_revision,
      'changed_sections', to_jsonb(v_changed_sections),
      'agent_run_id', p_agent_run_id,
      'source', COALESCE(p_source, 'control_plane')
    )
  );

  RETURN NEXT v_memory;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_client_memory_patch(
  uuid, uuid, bigint, jsonb, jsonb, text, uuid, uuid, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.apply_client_memory_patch(
  uuid, uuid, bigint, jsonb, jsonb, text, uuid, uuid, text
) TO service_role;
