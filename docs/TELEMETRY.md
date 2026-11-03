# OpenBot product telemetry contract v1

This contract covers the OpenBot producer in one PR. Intelligence context validation/persistence/export, generic sink deduplication, website acquisition and live PostHog dashboards are separate deployment dependencies. Local audit remains authoritative. The optional customer OTLP/SIEM exporter is independent of product analytics.

## Configuration and identity

`OPENBOT_PRODUCT_TELEMETRY=1` enables the richer events below. Unconfigured self-hosted, organization-hosted and local-evaluation servers do not start richer collection or central export. The desktop distribution defaults on under its existing setup telemetry disclosure; `OPENBOT_PRODUCT_TELEMETRY=0` disables richer collection there. `DO_NOT_TRACK=1|true` or `COPILOTKIT_TELEMETRY_DISABLED=1|true` takes precedence everywhere. Disabled mode does not open the richer identity/ledger or project audit events. Existing local audit behavior remains unchanged.

Events use the public `@copilotkit/shared` 1.83.0 `lambdaClient.send` API and the existing CopilotKit sink (`COPILOTKIT_TELEMETRY_URL` override remains available). The SDK runtime always gets `app_id=openbot`, including with accessibility disabled. Only immutable deployment facts enter runtime `telemetryProperties`; per-user/run facts never mutate the runtime singleton.

When richer collection is enabled, `enterprise_settings.product_telemetry_identity_v1` holds one random deployment UUID and random HMAC salt. Initialization uses insert-on-conflict followed by reading the winning value, so replicas/restarts agree. Failure or corrupt identity disables richer capture with a bounded warning; no ephemeral fallback invents continuity. The HMAC of deployment UUID and authenticated local actor ID is exported as `user_id`. Names, emails and raw local actor IDs do not leave the deployment. PostgreSQL keeps the local actor ID for ownership checks only. The configured `DEPLOYMENT_ID` remains the existing thread-minting namespace; it is not repurposed as a person identity.

Database backups preserve identity and activation markers. A fresh database/reinstall creates a new deployment and new pseudonyms. Cloning a database clones its telemetry identity; operators creating an independent deployment should remove only the telemetry identity/ledger as part of provisioning, before enabling export. The desktop's existing `CPK_TELEMETRY_ID` installation handoff remains a transport claim, separate from the scoped user. API-key creator is not inferred to be the user.

## Run evidence

Every prepared run carries a signed, actor/thread/run-bound `forwardedProps.openbotTelemetry` receipt. Browser claims in this namespace are replaced at the authenticated runtime request boundary. Headless turns and handoffs prepare their own trusted receipt before the runner receives the input. Remote agent clones retain the observer through the public middleware API.

Context fields: `schema_version=1`, `app_id`, `deployment_id`, scoped `user_id`, `root_task_id`, `run_id`, `attempt_id`, nullable numeric `attempt`, optional `parent_run_id`, `trigger`, `surface`, `environment`, `purpose`. `attempt_id=run_id`; a numeric queue ordinal is emitted only when known. Browser retries of the same last user-message ID share a root and have separate run/attempt IDs. Known root IDs hash authenticated actor/thread/ask identity. Missing child/followup/unknown root linkage is null, not a new invented root. Parent linkage is preserved only from an existing same-actor local ledger record. A missing parent remains missing; its lineage is not invented. Trusted project/tenant scope still belongs to Intelligence's authentication boundary and is not guessed from an API key.

`trigger` is `human|routine|followup|subagent|unknown`. Runtime browser requests, manually run routines, person-started tasks and first group turns are human. Scheduled routines/responsibilities are routine; wake-ups/approval continuations are followup; delegated and subagent turns are subagent. Existing callers without an authoritative label stay unknown. Web runtime, desktop runtime and group/task web entry are known surfaces; headless/unknown external origins remain `unknown` rather than being guessed from user agent. Mobile and external-channel population coverage remains incomplete.

Events are `oss.runtime.openbot.run_accepted`, `.run_terminal`, `.first_human_success`, `.capability`, `.result_viewed`, `.result_copied`. Each carries a stable producer `event_id` and UTC `occurred_at`. Lifecycle events also carry `thread_id` and the context above. `run_accepted` means the runner reached the actual agent execution boundary after admission/join; it is not an HTTP request count. Duration begins at that boundary and ends at the observed terminal. Failed initialization before that boundary is not an accepted run.

The observer sees source agent events before runner terminal synthesis. A real `RUN_ERROR` is error; a real `RUN_FINISHED` is normal protocol completion, including legacy producers omitting `outcome` as specified by AG-UI. Explicit interrupt becomes unknown, explicit cancelled becomes cancelled. Stream completion alone is unknown (`missing_terminal`). Host-observed cancellation/timeout has a bounded category; an unobserved stop is unknown. An accepted run lost with a process remains outstanding, not presumed successful. The ledger uses conditional finish-once updates. Child terminal evidence never determines root outcome. `is_root=true` is limited to observed human/routine roots without a parent; subagent/followup runs are not promoted to roots when parent linkage is missing, and unknown initiation has null root authority.

`first_human_success` is persisted once per deployment-scoped user, only for an observed ordinary human root success. It is distinct from viewing, copying, usefulness and the desktop wizard's existing activation. The wizard's Ask invokes the selected harness directly and bypasses this runtime, so it does not generate this milestone. No prompt content is inspected to infer demos; externally injected demo traffic without a dedicated trusted route remains a known classification limitation.

## Capability coverage

The audit tap supplies the actual row ID after insertion; the exporter rebuilds a closed projection and never forwards the audit payload. Native/headless action scope supplies run linkage when available. Existing MCP audit callers put the actor in the trusted audit `payload.actor`; that specific local source is pseudonymized without exporting the payload. Missing actor/run attribution stays missing. Transactional audit taps observe insertion rather than a commit acknowledgement; complete cross-replica delivery/commit reconciliation remains a receiver/producer follow-up dependency.

| Family | Authoritative source | Projection and limits |
| --- | --- | --- |
| Connections | Account connected/verified/disconnected, authorization cancelled/unreconciled | Setup attempt/verification/failure/cancellation; source event distinguishes disconnect. No vendor URLs/names/scopes. |
| Tool use | `mcp.call_succeeded/failed/rejected`, callback refused | Automated use completed/failed/rejected. Tool arguments, results and names excluded. |
| Approval | Evaluated policy outcome; person decision; withdrawal | Requested/rejected/attempted, human completion/rejection, cancellation. Withdrawal is not proof the person abandoned work. |
| Bots | Created/duplicated/updated/paused/resumed/deleted; isolation refused | Setup/state transitions. Run evidence measures use; no customer-authored names. |
| Routines | Created/updated/deleted/enabled changed; run lifecycle | Setup separated from scheduled/manual execution. |
| Computer | Action allowed/refused/failed/stopped; help/control/sign-in events | Allowed is attempted, not successful action. Human takeover/help and observable recovery retained separately. |
| Learning | Sharing changed, skill opened/closed | Sharing/access setup only. No claim of applying a Skill or improving output. Backend generation/approval/pull are outside this producer. |

Every event carries `capability`, `stage`, bounded `outcome`, `actor_kind`, original allowlisted `source_event` and bounded `initiator`. These describe actual operations; automated tool activity is not a new human request. Unsupported transitions have no invented completion events. Family-specific adoption queries must use the source events in this table, not treat every setup completion as a connection being created.

## Consumption endpoint

`POST /api/telemetry/product-events` requires the existing signed-in actor and accepts at most 4096 bytes of strict JSON:

```json
{"kind":"result_viewed","threadId":"...","messageId":"...","surface":"web","runId":"optional"}
```

Only `result_viewed|result_copied` and `web|desktop|mobile` are accepted. IDs are bounded to 256 characters; extra identity/content fields are rejected. The server resolves actor + thread + observed assistant message ID to the durable run. An optional run ID must match. `204` means recorded or already recorded; `202` means disabled, pending or unknown historical linkage; forged run mismatch returns `404`. Caller fields never supply actor, deployment, root, success or outcome. Duplicate/reload/reconnect submissions have the same durable event key. Raw assistant text is never submitted.

A view requires a nonempty rendered assistant result, foreground document visibility and viewport intersection. Copy requires the existing full-answer copy handler to report clipboard success. Code/table copy controls without a supported aggregate callback remain unmeasured. Assistant result IDs are recorded at the observed terminal; the UI retries bounded pending submissions while visible. Background completions and delivery do not count as views or human returns.

The current notification sheet opens an approval/question inbox. It has no delivered-result item/open transition, so notification delivery → open → view is unavailable; this PR does not emit `notification_opened` from a bell click. Current mobile/external channels and historical messages without local run linkage remain coverage gaps. There is no usefulness/feedback UI or inferred satisfaction.

## Delivery, deduplication and health

The queue defaults to 256 events per process (hard maximum 1024), with bounded pending writes. Overflow increments `dropped`, logs only a reason/counter, and never blocks the product operation. The local attempt journal retains event IDs; a transaction-scoped PostgreSQL advisory claim serializes sends of one event across replicas and rolls back on a thrown transport error/process death. The transaction holds at most one telemetry connection per replica during the shared sender's bounded three-second call. An injected transport rejection leaves an event pending for restart replay with the same producer ID. No immediate application-level retry loop is added. Startup replays a bounded pending batch. Run/event rows expire after 90 days on startup; the once-per-user first-success marker remains to prevent reactivation. Deployments with long uninterrupted uptime should schedule the documented retention SQL or restart through normal maintenance.

The shared sender deliberately swallows HTTP/network failures and does not return destination acknowledgement. `attempted_at`, health `attempted` and `lastAttemptAt` mean only that the shared send call completed, never that PostHog received it. Silent shared-transport failures cannot be classified by this adapter. The HTTP sink may acknowledge an event it later drops. This producer must not mark events delivered or claim exact delivery from HTTP success.

Current ingest accepts `oss.runtime.*`; generic fanout excludes `oss.runtime.agent_execution_*`, so these product names avoid that namespace. Ingest generates a transport event ID because shared1.83.0 has no top-level `event_id` argument. Generic PostHog fanout sets `$insert_id` but omits the native `uuid` dedupe key. Consequently producer ID properties survive, but physical destination deduplication is **not** guaranteed. The supplied queries deduplicate using producer `event_id`. Query B's CTE/join/countIf/avg structure was syntax-checked in EU PostHog project26816 on2026-11-03 (query933c1769-c819-456e-ae41-26605e4c0430,0rows); this is engine-compatibility evidence, not fixture-count or receipt proof. Shared sender/receiver support for stable top-level IDs and PostHog `uuid` remains an explicit dependency.

`GET /api/telemetry/health` is administrator-only, explicitly labels counters as process-local (`scope=process`), and exposes enabled/queued/attempted/dropped/failed/lastAttemptAt plus `transportAcknowledgesDelivery=false`, with no user IDs or payloads. Database freshness/outstanding queries and PostHog receipt queries are in [telemetry-queries.sql](telemetry-queries.sql). Operator: OpenBot maintainer investigates producer failures; telemetry-sink owner investigates queue/fanout/destination freshness. No scheduled alert is installed by this PR.

### Dated receiver observation — 2026-11-03

During validation at 17:47–18:04 UTC, the existing `TelemetrySink` SQS queue had approximately 782,412 messages and oldest-message age 5,204 seconds (~87 minutes); DLQ count was zero. A later failure sample showed Reo429 throttling, while the queue grew because each record waits for all sink attempts. No PostHog-specific canary error/drop was observed in the sampled logs. EU PostHog project 26816 was confirmed as the configured destination. This is external pipeline evidence, not a demonstrated OpenBot producer defect. A trustworthy canary arrival bound cannot be promised while that backlog's drain rate is unknown. Investigate queue depth/oldest age, fanout failure logs and the exact canary query before declaring freshness or received delivery.

The synthetic server canary sent at 17:54:41 UTC used deployment `openbot-canary-20261103-server-v1` and produced five send attempts. This initial canary predates the final `attempt_id` field (its `run_id` still identifies the attempt). Destination receipt remains unconfirmed unless the final PR validation records actual matching payloads. Do not resend merely because a queued event is not yet searchable.

## Validation and external completion dependencies

`bun server/scripts/product-telemetry-canary.ts` sends synthetic, content-free events using the real shared transport. Set `OPENBOT_CANARY_ID` to identify a deliberate run. Its `NODE_ENV=test` and `deployment_environment=test` exclude vendor production enrichment. Validate all expected received fields, stable producer IDs and joins in PostHog; script exit zero is not delivery proof.

Producer fixtures cover opt-out, two actors/deployments, signed-context isolation, retry/child lineage, actual success/error/cancel/interrupt/missing terminal, queue overflow, interrupted export, real PostgreSQL identity/ledger persistence, ownership and duplicate consumption. Existing affected runtime/orchestration checks remain in CI. Browser UI and desktop provider contract fixtures are owned with their respective components.

Before complete cross-system reporting: Intelligence must validate this reserved context against authenticated project/tenant and persist/export it in accepted and terminal summaries; sink must preserve stable IDs and supply native deduplication; destination canaries must arrive with expected joins; live saved reports/alerts must be configured and verified. Legacy missing app/project/root attribution remains unknown. Existing website/acquisition routes have no safe established source-handoff token in this producer; acquisition-to-activation linkage is unavailable until a separate website/receiver contract exists. No fingerprinting or new tracking UX is introduced.
