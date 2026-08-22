-- TRUNCATE erases the audit trail, and the append-only trigger never runs.
--
-- `audit_events_append_only` is BEFORE UPDATE OR DELETE ... FOR EACH ROW
-- (0000_schema.sql:403). A row-level trigger cannot fire on TRUNCATE at all, so
-- `TRUNCATE audit_events` removes every row without raising. The guarantee the
-- schema states -- "a trail anybody can edit after the fact answers no question
-- worth asking", enforced in the database "because the application is not the
-- only thing that can reach this table" -- is exactly what TRUNCATE defeats, and
-- for exactly the reader that comment has in mind.
--
-- The obvious fix is wrong, so this does not use it. Pointing a BEFORE TRUNCATE
-- trigger at the existing function looks correct and fails open: a statement
-- trigger has no OLD record, so `OLD.created_at >= now() - ...` is NULL, the IF
-- does not fire, and control reaches RETURN OLD. It refuses only while
-- `openbot.audit_retention_days` is unset. Set it -- which is what the retention
-- sweep does -- and the truncate is permitted. Verified both ways against
-- Postgres before writing this: unset raised, set to '30' truncated the table.
--
-- So the TRUNCATE branch is answered before the setting is read. Retention
-- removes rows it can name and date; it never removes the table's contents
-- wholesale, so there is no window in which TRUNCATE is the intended path.
CREATE OR REPLACE FUNCTION prevent_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  retention_days integer;
BEGIN
  -- Before the setting is consulted: TG_OP is the only thing a statement-level
  -- invocation can be trusted to have, and every row-level field is absent.
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Audit events are append-only';
  END IF;

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
$$;--> statement-breakpoint

CREATE TRIGGER audit_events_no_truncate
BEFORE TRUNCATE ON audit_events
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_audit_event_mutation();
