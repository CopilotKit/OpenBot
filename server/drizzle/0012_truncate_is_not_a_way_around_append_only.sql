-- Close the one statement that emptied the audit trail without raising anything.
--
-- `audit_events_append_only` is a row-level trigger, and a row-level trigger cannot fire on
-- TRUNCATE. So every UPDATE and DELETE was refused while `TRUNCATE audit_events` removed every row
-- in the table and returned success. The guarantee 0007 restates as "we deleted the rows about the
-- incident must stay impossible" had a one-statement way around it.
--
-- Retention is unaffected, because retention deletes. It names a window and removes what is older
-- than it, and the rows about last night survive by being newer. TRUNCATE cannot name a window: it
-- takes the whole table, recent rows included, which is the thing the trail exists to prevent. So it
-- is refused outright, in every session, whatever any setting says.
--
-- The obvious version of this fix fails open, which is why the operation is answered first. A
-- statement-level trigger has no OLD record, so reaching `OLD.created_at >= now() - ...` compares
-- against NULL, the IF does not fire, and control falls through to `RETURN OLD` and the truncate
-- proceeds. That path is reachable exactly while a retention sweep has set the window: the state a
-- happy-path test does not check. Answering TG_OP before the setting is read removes the path
-- rather than guarding it.
CREATE OR REPLACE FUNCTION prevent_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  retention_days integer;
BEGIN
  -- Answered before anything else is read, so no setting and no missing OLD record can change it.
  IF TG_OP = 'TRUNCATE' OR TG_OP = 'UPDATE' THEN
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

-- Separate from the row-level trigger because the two fire on different things: one per row for
-- UPDATE and DELETE, once per statement for TRUNCATE. They share a function so the refusal is
-- written in one place and cannot drift apart.
DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events;

CREATE TRIGGER audit_events_no_truncate
BEFORE TRUNCATE ON audit_events
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_audit_event_mutation();
