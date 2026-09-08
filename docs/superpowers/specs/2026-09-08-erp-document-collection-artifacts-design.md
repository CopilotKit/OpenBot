# ERP document collection and governed artifact ingestion

> **Superseded:** This design was replaced before implementation by
> `2026-09-08-inter-agent-file-attachments-design.md`. Do not implement the collection-job or shared
> outbox architecture described below.

## Goal

Let a person ask `jefe-erp` for missing supplier invoices in one natural request. Jefe ERP identifies
the ERP records that lack documents or reconciliation, delegates exact search criteria to
`recolector-documentos`, receives verified downloaded artifacts, presents the resulting ERP changes
for human approval, and then causes `erp.netsfera.es` to ingest and associate the selected invoices.

PDF bytes must never pass through model context or handoff text. A local file is deleted only after
the ERP confirms a successful ingestion, an exact duplicate, an explicit human rejection, or expiry
after 30 days.

## Repositories and deployment boundaries

The feature spans two systems:

- OpenBot (`/Users/xavi-mac/code/company/OpenBot`) owns coworkers, handoff, browser downloads,
  collection jobs, artifact storage, authenticated chat approval, signed artifact delivery, and
  retention.
- Netsfera ERP (`/Users/xavi-mac/code/company/netsfera-erp`) owns ERP searches, proposals, document
  ingestion, OCR scheduling, invoice-to-movement association, reconciliation, duplicate detection,
  and the `erp-jefe` MCP contract.

`bot.netsfera.es` and the `erp-jefe` MCP at `erp.netsfera.es` are separate hosts. A Docker volume on
the Bot host cannot be mounted by the ERP. OpenBot therefore retains the local shared volume and
exposes only an authenticated, short-lived delivery capability for an exact artifact. The ERP is a
pulling client of that capability; it never receives an arbitrary URL from the model.

## Scope

This design includes:

- querying the ERP for missing documents and unassociated movements before browsing;
- a durable collection job that carries exact ERP targets to the collector;
- a dedicated document outbox shared only by the collector computer and trusted OpenBot server;
- publishing verified downloads as immutable artifact records;
- returning artifact identifiers and metadata to Jefe ERP through normal text handoff;
- individual selection or whole-batch selection followed by one final authenticated approval;
- approval of both ingestion and the displayed association/reconciliation for each selected item;
- service-to-service artifact delivery, byte validation, idempotent ERP ingestion, and per-item
  acknowledgement;
- immediate deletion after successful ingestion or exact duplicate, and 30-day expiry otherwise;
- correction of the OpenAI provider skill so one authorized collection does not prompt again for
  each invoice.

This design does not include:

- sending attachments or base64 through `message_bot`;
- sharing the collector's complete workspace with Jefe ERP;
- granting a browser, shell, or arbitrary filesystem access to Jefe ERP;
- automatically choosing ambiguous invoice-to-movement matches;
- confirming OCR-derived fiscal treatment, VAT, accounting entries, or fiscal posting;
- accepting an arbitrary remote URL or local ERP filesystem path as an artifact source;
- unattended ingestion without authenticated human approval.

## End-to-end flow

### 1. Create the collection job

The person asks Jefe ERP to find, download, upload, and associate missing OpenAI invoices. Jefe ERP
uses its existing read tools to obtain every relevant movement and invoice state. It creates a
durable collection job through `document_collection_create` with normalized targets containing:

- ERP movement or invoice target id;
- booking date and optional value date;
- signed amount, absolute amount, and currency;
- normalized description and expected provider;
- current document, association, and reconciliation state;
- an explicit date window and amount/currency matching rule;
- the requested effects: ingest and, where eligible, associate/reconcile.

OpenBot generates `collectionJobId`; the model cannot choose it. The job snapshot is immutable. A
new ERP query produces a new revision rather than rewriting the evidence on which an earlier result
was based.

Jefe ERP hands the job to `recolector-documentos` using native `message_bot`. The handoff includes a
human-readable task plus the opaque `collectionJobId`. Exact criteria remain in the stored job so
neither model paraphrasing nor transcript truncation can change them.

### 2. Discover and download

The collector calls `document_collection_get` and searches only the reviewed provider portals. The
initial request authorizes discovery and download of unambiguous matches to the stored criteria; it
does not authorize an ERP mutation. The collector must not ask again for each ordinary invoice link
or download button in an already authorized job.

Authentication, CAPTCHA, consent, account switching, or an actual policy refusal still stops for
human control. A normal allowed click is not a reason to escalate. Ambiguous candidates are recorded
on the job and returned to Jefe ERP for human selection; the collector does not guess or download a
substitute.

For each clear match, Chromium saves the original into `/workspace/downloads`, which is the mounted
document outbox. The collector calls `document_artifact_publish` with `collectionJobId`, the relative
file path, source invoice identifier, and proposed ERP target id. OpenBot itself:

1. confines and resolves the path beneath the outbox;
2. refuses symlinks, non-regular files, unsupported MIME/magic bytes, and files over 10 MiB;
3. waits until size and modification time are stable;
4. computes filename, byte length, MIME type, and SHA-256 from the actual bytes;
5. creates an immutable `artifactId` bound to the job revision and proposed target;
6. makes a second publication of the same SHA-256 and job idempotently return the existing artifact.

The collector's answer contains the job id and a compact artifact manifest. It never contains bytes,
credentials, signed delivery URLs, or claims that the ERP has accepted anything.

### 3. Revalidate and approve

When the answer is relayed, Jefe ERP loads the completed job and re-reads the relevant ERP records.
Anything already documented, associated, reconciled, changed, closed, or otherwise stale is removed
from executable scope and shown as such.

Jefe ERP presents a selectable batch with, per row:

- ERP movement and current status;
- provider invoice number, issue date, amount, and currency;
- artifact filename, byte length, and abbreviated hash;
- match evidence and any discrepancy;
- proposed ingestion and association/reconciliation effects;
- exact duplicate or conflict status when already known.

The person may select individual rows or the entire eligible batch. `askApproval` then shows the
exact selected effects. Approval is recorded server-side as an `artifactApprovalId` bound to actor,
job revision, ordered artifact ids, complete hashes, ERP targets, effects, policy version, and expiry.
Changing any bound field makes it stale. The authenticated OpenBot session, not an `approved: true`
model argument, establishes who approved.

One approval covers ingestion plus the displayed association/reconciliation for each selected row.
If the ERP needs OCR before it can execute an approved association, the same approval authorizes a
deferred association attempt only for the exact document hash, target, amount, currency, and effects
shown in that proposal. The worker revalidates those invariants after OCR under fresh ERP locks. A
changed value, a different candidate, or a newly ambiguous match marks that item stale and requires
a new proposal and approval; it never silently narrows or expands the approved action. OCR-derived
fiscal confirmation, VAT treatment, accounting, and posting remain separate reviewed operations.

### 4. Transfer, ingest, and acknowledge

The ERP MCP exposes two new tools:

- `erp_expenses_ingest_artifacts_prepare` validates the job, artifacts, targets, principal, and
  proposed effects and returns the exact review proposal/fingerprint.
- `erp_expenses_ingest_artifacts` consumes that fingerprint and the OpenBot approval reference,
  revalidates everything, and executes the approved batch idempotently.

The execute tool exchanges the approval reference over an authenticated service channel. OpenBot
returns delivery capabilities only to the ERP service process and only for the approved artifact
ids. A capability is HTTPS-only, audience-bound to the ERP service identity, valid for five minutes,
and single-use for a completed fetch. Neither the capability nor its content URL is returned through
an MCP result, Bot transcript, browser session, or ordinary log.

The ERP pulls each file, enforces the declared 10 MiB limit, checks content type and magic bytes,
recomputes size and SHA-256, and rejects any mismatch before persistence. It then uses the existing
received-invoice ingestion and durable OCR path. Association/reconciliation runs immediately when
the required verified fields already exist, or is queued behind OCR using the same immutable
approval fingerprint. In both cases it executes only while the approved proposal remains valid under
fresh ERP locks and domain guards; otherwise the item becomes stale without association.

The ERP sends an authenticated per-artifact acknowledgement to OpenBot:

- `ingested`, with durable ERP document/operation ids;
- `exact_duplicate`, with the existing document id and the exact identity evidence;
- `failed`, with a stable sanitized code and retryability;
- `stale` or `conflict`, when approval or ERP state no longer matches.

OpenBot deletes bytes immediately only for `ingested` and proven `exact_duplicate`. It retains failed,
stale, and conflicting artifacts for retry or review.

## Components

### Dedicated outbox volume

A named volume `openbot-document-outbox` is mounted:

- read/write at `/workspace/downloads` only in `recolector-documentos`;
- read/write at a private path in the trusted OpenBot server for validation, delivery, and deletion;
- nowhere in Jefe ERP or other Bot computers.

The supervisor receives an explicit allowlisted bot-to-volume configuration. It must not infer shared
mounts from caller input. Existing per-Bot profile and workspace volumes remain isolated.

### OpenBot persistence

`document_collection_jobs` stores job id, owner/actor, requesting and collecting Bot ids, immutable
ERP criteria snapshot, revision, state, timestamps, and 30-day expiry.

`document_artifacts` stores artifact id, job revision, source/target metadata, canonical relative
name, MIME, size, SHA-256, lifecycle state, attempt count, ERP result ids, expiry, and timestamps. It
never stores bytes or signed capabilities.

`document_artifact_approvals` stores the authenticated approver and canonical proposal fingerprint.
It never stores a reusable credential.

State transitions use conditional updates and idempotency keys. Invalid backward transitions are
refused rather than repaired silently.

### OpenBot governed tools

- `document_collection_create`: Jefe ERP only; records targets read from granted ERP results.
- `document_collection_get`: restricted to the requesting Jefe ERP and assigned collector.
- `document_artifact_publish`: assigned collector only; publishes a file belonging to its job.
- `document_collection_review`: Jefe ERP only; returns the revalidated selectable manifest.
- `document_artifact_approval`: backed by authenticated `askApproval`, not a free model boolean.

Each call is policy-checked and audited. Tool results are compact metadata.

### Service endpoints

OpenBot provides private endpoints for ERP proposal validation, approval exchange, artifact content,
and acknowledgement. They require the ERP service identity in addition to a short-lived capability.
No endpoint accepts a caller-supplied filesystem path. The content endpoint sets attachment-safe
headers, disables caching, and streams bytes without buffering them into model-visible JSON.

The ERP stores OpenBot's service endpoint and trust material as deployment configuration, never in
MCP tool arguments. OpenBot allowlists the ERP origin and audience.

## Lifecycle and retention

The normal state path is:

```text
collecting -> staged -> proposed -> approved -> transferring -> ingested -> deleted
                                                        \----> exact_duplicate -> deleted
```

Other paths are:

- explicit human rejection -> deleted;
- ambiguous match -> retained without approval until resolved or expired;
- retryable technical failure -> staged with attempt metadata;
- stale approval or ERP conflict -> retained and requires a new review;
- no decision or unresolved failure for 30 days -> expired and deleted.

Expiry and deletion are durable worker jobs, not in-process timers. Deletion is confined to the
recorded canonical outbox file and is idempotent. Audit retains metadata, state changes, reason, and
hash after bytes are gone.

## Failure and recovery

- A collection job with no candidates completes successfully with the searched accounts, filters,
  and date range recorded.
- Partial portal failure preserves published artifacts and reports each missing target separately.
- A handoff retry reuses `collectionJobId`; it cannot create a second logical job.
- A duplicate publication returns the existing artifact for the same job and hash.
- A transfer timeout is an unknown result, not proof of failure. The ERP reconciles by idempotency key
  and document hash before retrying.
- A single failed item does not roll back confirmed independent items. Results are per item.
- A consumed capability cannot fetch a different artifact and cannot be replayed after a completed
  transfer. An interrupted fetch may be resumed only through a new capability after state review.
- If acknowledgement is lost after ERP commit, ERP status/idempotency reconciliation recovers the
  durable result before OpenBot deletes anything.
- Disabling the feature stops new publications and transfers but retains existing bytes and records.

## Provider-skill changes

`descargar-facturas-openai` and the provider-authoring contract are updated so that:

- a job's stored ERP criteria are authoritative;
- the initial request authorizes discovery and download of clear matches;
- a collector does not request a second confirmation for each allowed invoice click;
- human control is reserved for authentication, sensitive interaction, ambiguity, or actual policy
  refusal;
- every completed download is verified and published;
- the response reports `collectionJobId`, artifact ids, filenames, hashes, matches, failures, and
  ambiguities;
- it never claims ingestion, association, or reconciliation.

## Security properties

- Bot workspaces remain isolated; only a narrowly scoped outbox is shared with the trusted server.
- Models handle identifiers and metadata, never document bytes or bearer capabilities.
- Approval is authenticated, exact, expiring, and stale on any content or target change.
- The ERP fetches only from the configured OpenBot origin and only by an ERP-audience capability.
- OpenBot accepts acknowledgements only from the configured ERP service identity.
- Path traversal, absolute paths, symlinks, unsupported content, oversized files, arbitrary URLs, and
  cross-job/cross-actor artifact references fail closed.
- Every create, publish, review, approval, delivery, acknowledgement, expiry, and deletion is audited
  without content or secrets.

## Testing

OpenBot unit tests cover path confinement, symlinks, file stability, magic bytes, size limits, hashes,
idempotent publication, state transitions, approval fingerprints, expiry, capability audience,
single use, and deletion rules.

ERP unit tests cover proposal fingerprints, authenticated approval validation, pull-origin allowlist,
byte verification, duplicates, stale resources, idempotency, association guards, and per-item result
codes.

Contract tests use shared fixtures for job/artifact metadata, approval exchange, content headers,
acknowledgements, and error codes. Neither repository may change those contracts independently.

An integration environment exercises:

1. ERP missing-document search and durable job creation;
2. handoff to the collector;
3. real Chromium download into the outbox;
4. publication and relay back to Jefe ERP;
5. individual and whole-batch selection;
6. rejection with no ERP mutation;
7. authenticated approval, signed pull, hash verification, ingestion, and association;
8. exact duplicate handling;
9. partial failure and retry;
10. restart survival and 30-day cleanup.

The production canary uses one reversible, known invoice. Audit evidence must show the complete
correlation from ERP target through job, artifact, approval, MCP operation, acknowledgement, and
deletion.

## Deployment

The feature is gated by `DOCUMENT_ARTIFACTS_ENABLED=false` and cleanup has an independent initial
dry-run gate. Deployment order is:

1. Back up OpenBot source/database and ERP state required by their existing runbooks.
2. Deploy OpenBot schema, outbox mount, tools, endpoints, and worker with the feature disabled.
3. Verify publication, capability delivery, expiry, and cleanup against an ERP simulator.
4. Deploy ERP MCP prepare/execute tools and service authentication without granting them to Bots.
5. Run cross-system contract and staging integration tests.
6. Grant the new tools only to Jefe ERP and update the two relevant skills.
7. Enable artifact collection with automatic deletion still in dry-run.
8. Execute one approved production canary and reconcile ERP and OpenBot audit evidence.
9. Enable deletion for confirmed success, exact duplicate, rejection, and 30-day expiry.
10. Execute a small multi-item batch including a controlled duplicate and partial failure.

Rollback disables new jobs and transfers first. Existing artifacts remain available for the 30-day
window; rollback never restores or deletes document bytes implicitly.

## Acceptance criteria

- One request to Jefe ERP can identify missing OpenAI invoices, delegate collection, return artifacts,
  request one exact approval, ingest, and associate the selected set.
- Clear matches do not prompt for a second download approval; ambiguous matches never proceed
  silently.
- Jefe ERP and handoff transcripts never receive PDF bytes or signed URLs.
- A changed byte, ERP target, requested effect, actor, or policy version invalidates approval.
- A deferred post-OCR association is covered by the original approval only while every approved
  invoice, movement, and effect invariant is unchanged; otherwise it requires a new approval.
- Only successful ingestion and exact duplicates delete immediately; failures remain recoverable.
- Repeated calls and network timeouts cannot create duplicate ERP documents or associations.
- Fiscal confirmation and posting remain outside this approval and require their existing controls.
- Pending bytes are removed after 30 days while metadata-only audit remains.
