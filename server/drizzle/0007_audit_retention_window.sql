-- Let a retention policy remove old audit rows, and nothing else remove anything.
--
-- The trail is append-only and that is enforced here rather than in the application, because the
-- application is not the only thing that can reach this table. That guarantee is worth keeping
-- exactly as strong as it was: a trail anybody can edit after the fact answers no question worth
-- asking, and "we deleted the rows about the incident" must stay impossible.
--
-- A deployment still has to be able to say how long it keeps the trail. An enterprise buyer asks for
-- that as a control, and the table is the largest one in the deployment within weeks of real use.
--
-- So DELETE becomes possible only under conditions the deleting statement has to state out loud:
--
--   * the session sets `openbot.audit_retention_days` to a positive whole number, and
--   * the row is older than that many days.
--
-- The setting is transaction-local in the sweep, so the permission cannot leak past the statement
-- that asked for it, and it cannot reach a recent row whatever it is set to. UPDATE stays refused
-- under every condition: retention removes history, it never rewrites it.
CREATE OR REPLACE FUNCTION prevent_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  retention_days integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Audit events are append-only';
  END IF;

  -- `true` so a session that never set it reads NULL instead of raising, which is the ordinary case
  -- and has to stay a plain refusal.
  BEGIN
    retention_days := nullif(current_setting('openbot.audit_retention_days', true), '')::integer;
  EXCEPTION WHEN others THEN
    retention_days := NULL;
  END;

  IF retention_days IS NULL OR retention_days < 1 THEN
    RAISE EXCEPTION 'Audit events are append-only';
  END IF;

  IF OLD.created_at >= now() - (retention_days || ' days')::interval THEN
    RAISE EXCEPTION 'Audit events are append-only within the retention window';
  END IF;

  RETURN OLD;
END;
$$;
