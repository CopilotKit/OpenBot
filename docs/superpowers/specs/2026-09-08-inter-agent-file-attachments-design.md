# Inter-agent file attachments and ERP transfer

## Goal

Allow one OpenBot Bot to attach files from its own workspace to `message_bot`. OpenBot copies each
file into a private inbox in the recipient Bot's workspace and delivers only verified metadata and
the recipient-local path in the handoff. Jefe ERP can then request one human approval and stream an
approved invoice from its workspace to the existing Netsfera ERP document-ingestion flow without
placing file bytes or credentials in model context.

This replaces the earlier collection-job and shared-outbox design. The ordinary handoff remains the
workflow record: Jefe ERP sends exact search criteria as typed text, the collector returns the files
as attachments, and Jefe ERP rechecks ERP state before asking for approval.

## Scope

This design includes:

- optional attachments on `message_bot`;
- copy-on-handoff between two isolated Bot workspaces;
- PDF, JPEG, PNG, WebP, plain-text, and CSV files, with a 10 MiB limit per file and 25 MiB per handoff;
- immutable attachment metadata: id, filename, media type, byte length, and SHA-256;
- an inbox path chosen by OpenBot, never by either model;
- visible attachment rows in the handoff UI;
- recipient-only listing, reading, and deletion through governed computer tools;
- a generic server-side workspace-file transfer tool for connector-managed upload sessions;
- the existing Netsfera ERP transfer reservation and upload endpoint, which already provide
  principal authentication, ingestion, duplicate detection, OCR scheduling, and transfer status;
- one authenticated approval before the selected ERP upload and proposed association;
- deletion after confirmed ingestion, proven exact duplicate, explicit rejection, or 30-day expiry.

This design does not include:

- a shared Docker volume or shared complete workspace;
- durable collection jobs or a general artifact catalogue;
- base64 or binary data in prompts, transcripts, tool arguments, or MCP JSON;
- caller-selected destination paths, arbitrary upload URLs, or raw credential arguments;
- automatic accounting, VAT classification, fiscal confirmation, or posting;
- sending directories, symlinks, executables, archives, or files over the configured limits.

## Handoff contract

`message_bot` gains an optional field:

```ts
type HandoffAttachmentInput = {
  path: string; // relative to the sending Bot's workspace
};

type HandoffEnvelope = {
  task: string;
  constraints?: string;
  expecting?: string;
  attachments?: HandoffAttachmentInput[];
};
```

The tool accepts at most ten attachments. The model supplies only source-relative paths. Before the
handoff is queued, OpenBot asks the sender's computer to export each file and streams it directly to
the recipient's computer. Neither computer receives the other workspace's mount.

OpenBot generates a deterministic `handoffId` from the signed run and normalized tool call, plus an
opaque `attachmentId` for each file. The destination is:

```text
/workspace/inbox/<handoffId>/<attachmentId>/<sanitized-filename>
```

The destination path cannot be supplied or changed by the model. A retry with the same handoff key
and identical hash returns the existing copy. A retry whose bytes differ fails closed.

The queued handoff stores only this verified recipient-side manifest:

```ts
type HandoffAttachment = {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  path: string; // recipient-relative inbox path
};
```

The recipient's model message lists the manifest and says that the files came from the named Bot.
The person's transcript renders the same filenames, types, and sizes. It does not inline PDF bytes,
image bytes, signed URLs, or secrets.

If any copy fails, `message_bot` queues no handoff. Successfully copied members of that incomplete
attempt are deleted idempotently. A source file changing during transfer is rejected by comparing
the exported size/hash with the completed import.

## Computer file-transfer boundary

Agent Computer gains two internal authenticated endpoints used only by the OpenBot server:

- `POST /files/export` validates a relative source path, refuses symlinks and non-regular files,
  validates allowed magic bytes/media type, applies byte limits while streaming, and returns headers
  containing canonical filename, media type, size, and SHA-256.
- `POST /files/import` accepts a server-generated handoff/attachment identity and stream, writes to a
  temporary file beneath `inbox`, validates the completed size/hash/media type, atomically renames
  it, and returns its recipient-relative path.

Existing workload identity and server-to-computer authentication protect both endpoints. They are
not browser-facing routes. Path confinement reuses the existing workspace rules, with a stricter
inbox-only destination policy for imports.

The recipient can use its existing computer tools for ordinary files. New governed operations list
handoff attachments and remove an exact attachment by id. Text may be read normally and images may
be inspected through existing computer capabilities. Binary files are referenced by path rather
than returned as text.

## ERP upload bridge

The existing `erp_documents_reserve_upload` tool already creates an opaque, expiring `transferId`
bound to the authenticated ERP principal, expected filename, media type, size, SHA-256, and
idempotency key. Its MCP result contains that id and a relative upload path, never an origin or
bearer token. No new ERP binary protocol is introduced.

OpenBot exposes a governed `transfer_workspace_file` tool with this model-visible input:

```ts
type TransferWorkspaceFileInput = {
  destination: string;
  transferId: string;
  attachmentId: string;
};
```

The tool resolves the attachment only from the current recipient Bot's inbox. It resolves the named
destination, fixed HTTPS origin, path template, and credential from server-side configuration,
exports the file from the current Bot's computer, and streams it to the destination path derived
from the validated UUID transfer id. The model cannot provide a URL, filesystem destination,
authorization header, or expected hash. The Netsfera target derives
`/api/agent-transfers/<transferId>` and authenticates with the same principal configured on its MCP
connector.

The existing ERP upload endpoint authenticates the same principal that reserved the transfer. It
locks the transfer, rejects expiry/replay, verifies media type, size, magic bytes, and SHA-256, and
stores the bounded bytes. Jefe ERP then uses the existing `erp_documents_transfer_status` and
`erp_expenses_ingest` tools. Ingestion reuses exact-duplicate detection and durable OCR scheduling;
the existing OCR worker remains asynchronous.

Jefe ERP re-reads the affected movement before approval and displays invoice metadata, movement,
attachment hash, upload, and proposed association. One `askApproval` authorizes that exact upload
and association. If association must wait for OCR, it remains authorized only while document hash,
amount, currency, movement, and proposed effects remain unchanged. Otherwise it becomes stale and
requires a fresh approval. Fiscal confirmation and posting remain separate.

On `ingested` or proven `exact_duplicate`, OpenBot deletes the recipient copy. On retryable failure,
conflict, or stale ERP state, it retains the file. Explicit rejection deletes it. A durable cleanup
sweep deletes unresolved inbox attachments after 30 days while retaining metadata-only audit.

## Persistence and audit

`handoff_attachments` stores attachment id, handoff id, sender and recipient Bot ids, recipient path,
filename, media type, size, SHA-256, lifecycle state, ERP result reference when present, and created,
expiry, and deleted timestamps. It stores no bytes or credentials.

The existing handoff work item carries attachment ids and the verified manifest. Audit records
attachment count and ids, hashes, state transitions, transfer outcome, rejection, expiry, and
deletion. It never records source paths, destination absolute paths, content, connector credentials,
or binary endpoint responses.

Only the sender may attach its files, only the exact recipient may consume the resulting attachment,
and only the recipient's current signed run may initiate an ERP transfer. Existing Bot-to-Bot grants
still decide whether `message_bot` is offered and whether the handoff is allowed.

## Failure and recovery

- A target computer that cannot be started makes the handoff fail before it is queued.
- Handoff retries are idempotent by handoff identity and attachment hash.
- A delivery retry references the already copied recipient files; it does not copy again.
- An ERP timeout is an unknown result. A repeated call uses the same upload-session idempotency key
  and checks transfer status before sending bytes again.
- A failed item does not delete or roll back other confirmed independent items.
- An interrupted import or upload leaves only a temporary file or unconsumed ERP session; bounded
  cleanup removes both.
- Removing a Bot deletes its inbox attachments through the same confined, audited cleanup path.

## Testing

OpenBot tests cover tool validation, source confinement, symlink refusal, MIME magic, limits,
mid-transfer changes, atomic import, rollback of partial batches, retry idempotency, recipient ACLs,
handoff delivery, UI rendering, transfer connector-origin confinement, authentication, audit
redaction, and deletion/expiry.

The existing ERP test suite remains the contract suite for reservation ownership, expected metadata,
expiry, replay, streamed byte limits, magic bytes, hash mismatch, exact duplicates, ingestion
idempotency, OCR scheduling, and sanitized results. OpenBot adds fixtures that prove its adapter is
compatible with that existing boundary.

An integration test downloads a fixture PDF into the collector workspace, attaches it to Jefe ERP,
confirms its inbox path and hash, rejects once with no ERP mutation, approves a second attempt,
streams it to an ERP test endpoint, verifies ingestion, and confirms deletion of the inbox copy.

## Deployment

The feature is disabled by `HANDOFF_ATTACHMENTS_ENABLED=false`. No ERP deployment is required unless
contract verification finds drift in its existing transfer boundary. OpenBot schema, computer
endpoints, handoff support, UI, transfer tool, and cleanup deploy with the flag disabled. Production
enables attachments only for the collector-to-Jefe ERP grant, keeps cleanup in dry-run, and exercises
one known invoice. After audit, hash, ingestion, and deletion evidence agree, normal cleanup is
enabled.

Rollback disables new attachments and transfers. Existing inbox files remain until the 30-day
cleanup window or explicit audited deletion; rollback never broadens workspace mounts or restores
deleted bytes.

## Acceptance criteria

- The collector can attach an existing downloaded invoice to `message_bot` without encoding bytes.
- Jefe ERP receives a verified local inbox path while all other Bot workspaces remain isolated.
- A retry cannot duplicate or silently replace an attachment.
- Neither model sees file bytes, connector credentials, arbitrary upload URLs, or absolute paths.
- One authenticated approval covers the exact upload and proposed association for selected files.
- The ERP verifies and ingests the same SHA-256 that OpenBot copied.
- Success and exact duplicates delete the recipient copy; retryable failures remain recoverable.
- Unresolved files expire after 30 days and their metadata-only audit remains.
