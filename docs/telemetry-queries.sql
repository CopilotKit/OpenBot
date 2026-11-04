-- PostHog/HogQL examples for the thin OpenBot event producer; no database setup.
-- Replace the dates with verified rollout/reporting coverage before publishing.
-- Deduplicate stable properties.event_id in PostHog. distinct_id is transport
-- identity, not a person. Use known (deployment_id,user_id) scope for user metrics.
-- Unknown identity remains visible in A; no internal/external classification exists.

-- A. Received event copies, stable-ID duplicates, identity and freshness coverage.
SELECT event, properties.environment AS environment,
       properties.deployment_id AS deployment_id,
       count() AS received_copies,
       count(DISTINCT properties.event_id) AS producer_events,
       countIf(properties.event_id IS NULL OR properties.user_id IS NULL
               OR properties.deployment_id IS NULL
               OR properties.deployment_id='unknown') AS unknown_scope_copies,
       max(timestamp) AS newest_received_utc
FROM events
WHERE event LIKE 'oss.runtime.openbot.%' AND properties.app_id='openbot'
  AND timestamp >= toDateTime('2026-11-03 00:00:00', 'UTC')
  AND timestamp < toDateTime('2026-11-04 00:00:00', 'UTC')
GROUP BY event,environment,deployment_id;

-- B. Accepted attempts and observed terminal outcomes. Missing is not failure.
WITH records AS (
 SELECT properties.event_id AS event_id,any(event) AS name,
        any(properties.deployment_id) AS deployment_id,
        any(properties.user_id) AS user_id,any(properties.thread_id) AS thread_id,
        any(properties.run_id) AS run_id,any(properties.trigger) AS trigger,
        any(properties.outcome) AS outcome,
        min(parseDateTimeBestEffort(properties.occurred_at)) AS observed_utc
 FROM events
 WHERE event IN ('oss.runtime.openbot.run_accepted','oss.runtime.openbot.run_terminal')
   AND properties.environment='production' AND properties.event_id IS NOT NULL
   AND timestamp >= toDateTime('2026-11-03 00:00:00', 'UTC')
 GROUP BY event_id
)
SELECT a.trigger,t.outcome,count() AS accepted_attempts,
       countIf(t.run_id IS NULL) AS missing_terminal,
       countIf(t.run_id IS NULL AND a.observed_utc < now()-INTERVAL 30 MINUTE) AS missing_after_window
FROM records a LEFT JOIN records t
 ON a.deployment_id=t.deployment_id AND a.user_id=t.user_id
 AND a.thread_id=t.thread_id AND a.run_id=t.run_id
 AND t.name='oss.runtime.openbot.run_terminal'
WHERE a.name='oss.runtime.openbot.run_accepted'
GROUP BY a.trigger,t.outcome;
-- Failed-run rate uses observed error/(success+error+cancelled+timeout).
-- Report unknown and missing separately. Child outcomes do not determine roots.

-- C. First observed ordinary human root success, computed from received events.
-- Use the entire verified collection period, not a rolling activity window.
WITH successes AS (
 SELECT properties.event_id AS event_id,
        any(properties.deployment_id) AS deployment_id,
        any(properties.user_id) AS user_id,
        min(parseDateTimeBestEffort(properties.occurred_at)) AS observed_utc
 FROM events
 WHERE event='oss.runtime.openbot.run_terminal'
   AND properties.trigger='human' AND properties.purpose='ordinary'
   AND properties.is_root=true AND properties.outcome='success'
   AND properties.environment='production' AND properties.event_id IS NOT NULL
   AND properties.deployment_id IS NOT NULL AND properties.deployment_id!='unknown'
   AND properties.user_id IS NOT NULL
   AND timestamp >= toDateTime('2026-11-03 00:00:00', 'UTC')
 GROUP BY event_id
)
SELECT deployment_id,user_id,min(observed_utc) AS first_observed_success_utc
FROM successes GROUP BY deployment_id,user_id;
-- This is not historical/global first use. Desktop setup is a separate funnel.
-- Human return requires another ordinary human root; automation-only activity
-- and consuming a routine result are separate from initiating new work.

-- D. Capability stages/outcomes after producer-ID deduplication.
WITH capability AS (
 SELECT properties.event_id AS event_id,
        any(properties.capability) AS capability,any(properties.stage) AS stage,
        any(properties.outcome) AS outcome,any(properties.source_event) AS source_event
 FROM events
 WHERE event='oss.runtime.openbot.capability'
   AND properties.environment='production' AND properties.event_id IS NOT NULL
   AND timestamp >= toDateTime('2026-11-03 00:00:00', 'UTC')
   AND timestamp < toDateTime('2026-11-04 00:00:00', 'UTC')
 GROUP BY event_id
)
SELECT capability,stage,outcome,source_event,count() AS observed_operations
FROM capability GROUP BY capability,stage,outcome,source_event;
-- Setup, successful use, failures and interventions remain separate operations.

-- E. Join observed views/copies to terminal result_message_ids even when the
-- browser does not know run_id. LEFT JOIN retains unmatched consumption.
-- JSONExtractArrayRaw/arrayJoin follows PostHog's documented array-property form.
WITH terminals AS (
 SELECT properties.event_id AS event_id,
        any(properties.deployment_id) AS deployment_id,
        any(properties.user_id) AS user_id,any(properties.thread_id) AS thread_id,
        any(properties.run_id) AS run_id,any(properties.outcome) AS outcome,
        any(properties.result_message_ids) AS result_message_ids
 FROM events
 WHERE event='oss.runtime.openbot.run_terminal'
   AND properties.environment='production' AND properties.event_id IS NOT NULL
   AND timestamp >= toDateTime('2026-11-03 00:00:00', 'UTC')
 GROUP BY event_id
), result_messages AS (
 SELECT deployment_id,user_id,thread_id,run_id,outcome,
        JSONExtractString(arrayJoin(JSONExtractArrayRaw(result_message_ids ?? '[]'))) AS message_id
 FROM terminals
), consumption AS (
 SELECT properties.event_id AS event_id,any(event) AS action,
        any(properties.deployment_id) AS deployment_id,
        any(properties.user_id) AS user_id,any(properties.thread_id) AS thread_id,
        any(properties.message_id) AS message_id,
        any(properties.consumption_surface) AS surface,
        min(parseDateTimeBestEffort(properties.occurred_at)) AS observed_utc
 FROM events
 WHERE event IN ('oss.runtime.openbot.result_viewed','oss.runtime.openbot.result_copied')
   AND properties.environment='production' AND properties.event_id IS NOT NULL
   AND timestamp >= toDateTime('2026-11-03 00:00:00', 'UTC')
 GROUP BY event_id
)
SELECT c.event_id,c.deployment_id,c.user_id,c.thread_id,c.message_id,
       c.action,c.surface,c.observed_utc,t.run_id,t.outcome,
       t.run_id IS NULL AS missing_execution_join
FROM consumption c LEFT JOIN result_messages t
 ON c.deployment_id=t.deployment_id AND c.user_id=t.user_id
 AND c.thread_id=t.thread_id AND c.message_id=t.message_id;
-- No matching execution is unknown coverage, not evidence of success/failure.
-- No view/copy is unobserved consumption, not dissatisfaction. Notification
-- open and usefulness have no event here; do not infer them from delivery.
