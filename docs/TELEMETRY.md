# OpenBot product telemetry

OpenBot forwards bounded usage events through the public `@copilotkit/shared` telemetry sender and the existing CopilotKit telemetry sink to PostHog. It adds no analytics database, migration, identity store, queue, replay service or administrator health endpoint. Local audit remains authoritative and independent of product analytics.

## Configuration and scope

Set `OPENBOT_PRODUCT_TELEMETRY=1` to opt in on self-hosted, organization-hosted and local-evaluation servers. The desktop distribution follows its existing telemetry disclosure; `OPENBOT_PRODUCT_TELEMETRY=0` disables these events. `DO_NOT_TRACK=1|true` or `COPILOTKIT_TELEMETRY_DISABLED=1|true` overrides collection everywhere. Existing `COPILOTKIT_TELEMETRY_URL` configuration still selects the shared sink.

`deployment_id` uses the existing `DEPLOYMENT_ID`, then `CPK_TELEMETRY_ID`, or the literal `unknown`. `user_id` is an HMAC of authenticated actor and deployment scope using the server's already-required `KEY_ENCRYPTION_KEY`; the key and raw actor ID are never exported. Changing that key or deployment identifier changes the pseudonym. Unknown deployment scope is reported separately, not presented as a known deployment or globally unique person. API-key ownership does not establish the identity of an end user.

CopilotKit's own runtime events always carry `app_id=openbot`, and carry this deployment's `deployment_id` only while product telemetry is on. OpenBot adds current execution context at its authenticated run boundary; it does not invent Intelligence project/tenant attribution. Intelligence must independently validate, persist and export matching context before cross-repository joins can be claimed complete.

## Intelligence run context

With product telemetry on, every run also states the shared Intelligence analytics context, version 1: `app_context_version`, `app_id=openbot`, `deployment_id` (or `unknown` when it does not fit `^[A-Za-z0-9_:.-]{1,128}$`), `app_user_hash` (the `user_id` pseudonym above), `trigger`, `surface`, `environment`, `purpose`, `root_task_id`, `parent_run_id` when known and `attempt`. Nothing else: no name, prompt, URL or raw identifier. A browser run carries it in `forwardedProps.__copilotkitAnalyticsContext`, which the CopilotKit runtime sends as `analyticsContext` on the thread lock. A headless turn and a Bot-to-Bot hop take the lock themselves and send it there, and never hand it to the agent. Whatever a browser sent under that key is replaced; with telemetry off it is removed and nothing is sent. `@copilotkit/runtime` 1.83.0 does not forward the field, so it reaches Intelligence once OpenBot runs a runtime release that does.

Browser runs are `web`, or `desktop` in the desktop distribution; the native app's messages are `mobile`; Slack, Teams and SMS are `external_channel`; other headless turns are `unknown`. A subagent carries the root task and surface of the run that started it, and a resumed turn its root task; a task's retry shares its first run's root with its own `attempt`. `purpose` is `ordinary` for every run the server sees: the desktop setup screen's question goes straight to the harness and never reaches the runtime.

## Events and interpretation

The event names are `oss.runtime.openbot.run_accepted`, `.run_terminal`, `.run_stop_requested`, `.capability`, `.result_viewed` and `.result_copied`. Common properties include `schema_version`, `app_id`, `event_id`, `occurred_at`, `deployment_id`, `user_id` and `environment`. Run events carry known thread/run/root/parent IDs, `attempt_id=run_id`, a numeric `attempt` only when available, `trigger`, `surface` and `purpose`. Unknown linkage stays unknown.

`run_accepted` records entry into agent execution, rather than every HTTP run/connect request. Only runs OpenBot started as work are counted: a person's, a routine's, a subagent's or a hop's. The runtime's own runs on a Bot, naming a new conversation or offering suggestions, carry no OpenBot context and emit no run events. `run_terminal` records the observed `outcome`, bounded `failure_category`, duration, `is_root` and up to 256 `result_message_ids`. An actual protocol finish without an explicit failure is normal completion; source errors, cancellation and timeout remain distinct. The host may emit `run_stop_requested` with a bounded stop reason; this records a request, not a terminal outcome. A run OpenBot knows it stopped ends `cancelled` with `failure_category` `none`: a person's Stop (on a browser run or on a thread a headless turn runs in), a stop that reaches a subagent, a headless cancel or pause, and a paused hop. A headless turn stopped at its deadline ends `timeout`. A lost lock is not a stop. Missing terminal evidence is unknown. A child run never determines its parent's outcome. Human initiation, scheduled routines, followups and subagents remain separate triggers.

Capability events project allowlisted audit categories, stages, outcomes and source event names for connections/tools, approvals, Bot and routine setup, computer interventions and Learning sharing/access. They exclude raw audit payloads, customer-authored names, tool arguments/results, URLs and credentials. A connection check completes only with actual verification evidence. Automated tool activity is not a new human request; Skill access is not proof of successful application or improved output.

There is no producer-side first-success event. PostHog deduplicates stable `event_id` properties, then derives first observed ordinary human root success per known deployment/scoped user. This is first use within verified collection coverage, not a historical or global first. Desktop wizard setup activation remains separate. Viewing and copying do not imply satisfaction.

## Observed result consumption

`POST /api/telemetry/product-events` requires the existing signed-in session and accepts a strict, size-bounded body:

```json
{"kind":"result_viewed","threadId":"...","messageId":"...","surface":"web","runId":"optional"}
```

The allowed actions are `result_viewed|result_copied`. The server derives actor/deployment metadata and forwards the supplied thread/message identifiers as observations; it performs no telemetry database lookup and does not infer execution success or root ownership from browser fields. An optional run ID is only an observed identifier. `204` means the handler completed, including when telemetry is disabled; it is not a PostHog receipt. The UI does not retry or persist failed observations.

Channel chat and direct Bot chat observe a settled, nonempty assistant markdown body only when it has positive viewport intersection and its document is visible. Each mounted body reports at most once. Reload/remount submissions can repeat and share the server's stable event ID for query deduplication. Direct Bot chat records the existing full-answer copy action only after clipboard success. Consumption events carry `consumption_surface`; they do not carry a client-inferred execution outcome.

PostHog joins consumption to terminal execution through scoped user, deployment, thread and membership of `message_id` in `result_message_ids`. The browser need not know the run ID. Unmatched observations remain visible as missing joins; a matching terminal establishes the observed execution outcome, not usefulness.

Tool/activity-only outputs, nested code/table copy controls, native mobile and external-channel consumption remain outside this UI coverage. The notification sheet is an approval/question inbox with no delivered-result open action, so a bell click emits no result-open event. Existing feedback behavior is unchanged and has no new product analytics event.

## Delivery and reporting limits

Sending is best effort through the existing transport. There is no local event journal, application-level telemetry retry, replay or exactly-once producer guarantee. Stable event IDs support deduplication in PostHog queries; physical sink/destination deduplication remains an external transport concern. Shared sender completion does not acknowledge destination receipt, and opt-out or unavailable transport can leave gaps.

[PostHog query definitions](telemetry-queries.sql) cover receipt/identity coverage, run outcomes, first observed success, capability use and message-to-terminal consumption joins. They are versioned examples, not installed dashboards or proof of received events. Set their coverage dates to the verified rollout and validate counts against actual destination records before publishing metrics. Keep unknown identity, missing joins, missing terminals, opt-out and surface exclusions visible. No internal/external customer classification is inferred.

The OpenBot maintainer owns producer investigation; the existing sink owner owns forwarding and destination receipt. Actual new-contract receipt, Intelligence context validation/export and live dashboard validation remain external completion dependencies. Website acquisition-to-activation linkage is unavailable without a verified handoff. No receipt canary is claimed for this corrected implementation.
