-- OpenBot product contract v1: query definitions, not installed dashboards.
-- PostHog/HogQL sections use Production project 26816, UTC, fixed window.
-- Replace the date literals deliberately. Native PostHog distinct_id is a transport
-- identity, NOT an OpenBot person. Use (deployment_id,user_id) for users.
-- environment='production' excludes test/development/unknown. No internal/external
-- classification is produced, so those populations remain unknown.

-- A. Receipt, freshness, producer-ID duplicates and coverage (all environments).
SELECT event, properties.environment AS environment,
       count() AS received_copies,
       count(DISTINCT properties.event_id) AS producer_events,
       countIf(properties.event_id IS NULL OR properties.user_id IS NULL
               OR properties.deployment_id IS NULL) AS missing_identity_copies,
       max(timestamp) AS newest_received_utc,
       max(properties.occurred_at) AS newest_producer_utc
FROM events
WHERE event LIKE 'oss.runtime.openbot.%'
  AND timestamp >= toDateTime('2026-11-03 00:00:00', 'UTC')
  AND timestamp < toDateTime('2026-11-04 00:00:00', 'UTC')
GROUP BY event, environment;

-- B. Accepted attempt outcomes. One stable producer ID per logical record.
-- Outstanding age starts at accepted agent execution, not HTTP arrival.
-- A missing terminal after 30 minutes is an investigation state, never failure.
WITH dedup AS (
 SELECT properties.event_id AS producer_id, any(event) AS name,
        any(properties.deployment_id) AS deployment_id,
        any(properties.user_id) AS user_id,
        any(properties.thread_id) AS thread_id,
        any(properties.run_id) AS run_id,
        any(properties.root_task_id) AS root_task_id,
        any(properties.trigger) AS trigger,
        any(properties.parent_run_id) AS parent_run_id,
        any(properties.outcome) AS outcome,
        any(properties.failure_category) AS failure_category,
        any(properties.duration_ms) AS duration_ms,
        min(parseDateTimeBestEffort(properties.occurred_at)) AS observed_utc
 FROM events
 WHERE event IN ('oss.runtime.openbot.run_accepted','oss.runtime.openbot.run_terminal')
   AND properties.app_id = 'openbot' AND properties.environment = 'production'
   AND timestamp >= toDateTime('2026-11-03 00:00:00', 'UTC')
   AND timestamp < toDateTime('2026-11-04 00:00:00', 'UTC')
 GROUP BY producer_id
)
SELECT a.trigger, t.outcome, t.failure_category,
       count() AS accepted_attempts,
       countIf(t.run_id IS NULL) AS outstanding_or_missing,
       countIf(t.run_id IS NULL AND a.observed_utc < now() - INTERVAL 30 MINUTE) AS missing_after_window,
       avg(t.duration_ms) AS mean_observed_duration_ms
FROM dedup a LEFT JOIN dedup t
 ON a.deployment_id=t.deployment_id AND a.user_id=t.user_id
 AND a.thread_id=t.thread_id AND a.run_id=t.run_id
 AND t.name='oss.runtime.openbot.run_terminal'
WHERE a.name='oss.runtime.openbot.run_accepted'
GROUP BY a.trigger,t.outcome,t.failure_category;
-- Failed-run rate = error / (success + error + cancelled + timeout).
-- Unknown and missing outcomes are reported separately and excluded from that
-- eligible terminal denominator. This is distinct from error-event share.
-- Root-task reporting must select known root runs and group root_task_id once;
-- no child failure is promoted to root failure. Missing parent linkage is a gap.

-- C. Human activity by UTC day, not deployment recurrence or automated work.
SELECT toDate(parseDateTimeBestEffort(properties.occurred_at)) AS day_utc, properties.deployment_id AS deployment_id,
       count(DISTINCT properties.user_id) AS scoped_human_users,
       count(DISTINCT properties.root_task_id) AS human_roots
FROM events
WHERE event='oss.runtime.openbot.run_accepted'
  AND properties.trigger='human' AND properties.purpose='ordinary'
  AND properties.environment='production'
  AND timestamp >= toDateTime('2026-11-03 00:00:00', 'UTC')
  AND timestamp < toDateTime('2026-11-04 00:00:00', 'UTC')
GROUP BY day_utc,deployment_id;
-- Return means another human root on a later UTC day for the same scoped user.
-- Viewing a routine result is consumption, not a new initiated-human task.

-- D. Connection attempt -> first successful tool use -> repeat use.
-- This is category-level adoption; no raw app/vendor names leave OpenBot.
WITH capability AS (
 SELECT properties.event_id AS producer_id,
        any(properties.deployment_id) AS deployment_id,
        any(properties.user_id) AS user_id,
        any(properties.stage) AS stage,
        any(properties.outcome) AS outcome,
        any(properties.source_event) AS source_event,
        min(parseDateTimeBestEffort(properties.occurred_at)) AS observed_utc
 FROM events
 WHERE event='oss.runtime.openbot.capability'
   AND properties.capability='connection' AND properties.environment='production'
   AND timestamp >= toDateTime('2026-11-03 00:00:00', 'UTC')
   AND timestamp < toDateTime('2026-11-04 00:00:00', 'UTC')
 GROUP BY producer_id
)
SELECT deployment_id,user_id,
       min(CASE WHEN source_event='mcp.account_connected' THEN observed_utc ELSE NULL END) AS connection_attempt_utc,
       min(CASE WHEN stage='use' AND outcome='completed' THEN observed_utc ELSE NULL END) AS first_successful_use_utc,
       countIf(stage='use' AND outcome='completed') AS successful_uses,
       countIf(stage='use' AND outcome='completed')>1 AS repeated_successful_use,
       countIf(outcome='failed') AS failures,countIf(outcome='rejected') AS rejections,
       countIf(outcome='cancelled') AS cancellations
FROM capability GROUP BY deployment_id,user_id;
-- Elapsed first-use time is first_successful_use_utc-connection_attempt_utc only
-- where both exist and are ordered. Existing connections at coverage start have
-- unknown setup time. Approval/computer interventions are separate capabilities;
-- join by scoped user and known root/run, never just by time proximity.

-- E. Execution-backed activation and consumption, with missing joins exposed.
WITH records AS (
 SELECT properties.event_id AS producer_id,any(event) AS name,
        any(properties.deployment_id) AS deployment_id,
        any(properties.user_id) AS user_id,any(properties.run_id) AS run_id,
        any(properties.outcome) AS outcome,min(parseDateTimeBestEffort(properties.occurred_at)) AS observed_utc
 FROM events
 WHERE event IN ('oss.runtime.openbot.run_terminal','oss.runtime.openbot.first_human_success',
                 'oss.runtime.openbot.result_viewed','oss.runtime.openbot.result_copied')
   AND properties.environment='production'
   AND timestamp >= toDateTime('2026-11-03 00:00:00', 'UTC')
   AND timestamp < toDateTime('2026-11-04 00:00:00', 'UTC')
 GROUP BY producer_id
)
SELECT r.deployment_id,r.user_id,r.run_id,r.outcome,
       min(CASE WHEN c.name='oss.runtime.openbot.result_viewed' THEN c.observed_utc ELSE NULL END) AS first_view_utc,
       min(CASE WHEN c.name='oss.runtime.openbot.result_copied' THEN c.observed_utc ELSE NULL END) AS first_copy_utc
FROM records r LEFT JOIN records c
 ON r.deployment_id=c.deployment_id AND r.user_id=c.user_id AND r.run_id=c.run_id
WHERE r.name='oss.runtime.openbot.run_terminal'
GROUP BY r.deployment_id,r.user_id,r.run_id,r.outcome;
-- No view/copy means unobserved consumption, not dissatisfaction. Notification
-- open and usefulness are not currently produced. Historical unlinked messages
-- cannot be joined and must not be attributed retroactively.

-- F. Exact synthetic canary receipt: five expected names and matching keys.
SELECT event,properties.event_id,properties.app_id,properties.deployment_id,
       properties.user_id,properties.root_task_id,properties.run_id,
       properties.attempt_id,properties.thread_id,properties.outcome,
       properties.message_id,properties.environment,properties.occurred_at,timestamp
FROM events
WHERE properties.deployment_id='openbot-canary-20261103-server-v1'
ORDER BY timestamp;

-- G. PostgreSQL local health, run against the OpenBot database (NOT HogQL).
-- SELECT count(*) FILTER (WHERE attempted_at IS NULL) AS pending_attempts,
--        min(created_at) FILTER (WHERE attempted_at IS NULL) AS oldest_pending_utc,
--        max(attempted_at) AS latest_attempt_utc
-- FROM product_telemetry_events;
-- SELECT context->>'trigger' AS trigger,count(*) AS accepted,
--        count(*) FILTER (WHERE terminal_at IS NULL) AS outstanding,
--        count(*) FILTER (WHERE terminal_at IS NULL AND accepted_at < now()-interval '30 minutes') AS missing_after_window
-- FROM product_telemetry_runs GROUP BY context->>'trigger';
-- Attempt completion is not received/delivered acknowledgement.

-- H. Optional deployment maintenance retention, PostgreSQL, after backup/policy review.
-- DELETE FROM product_telemetry_runs WHERE accepted_at < now()-interval '90 days';
-- DELETE FROM product_telemetry_events WHERE created_at < now()-interval '90 days'
--   AND name <> 'oss.runtime.openbot.first_human_success';
