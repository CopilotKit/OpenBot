# Inter-Agent File Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `recolector-documentos` attach downloaded invoices to `message_bot`, copy them into Jefe ERP's isolated workspace, and upload an approved attachment through the ERP's existing authenticated transfer boundary.

**Architecture:** Agent Computer owns confined binary export/import operations. OpenBot brokers copies between separately located computers, persists immutable attachment metadata, places the verified manifest on the durable handoff, and offers a server-side transfer tool whose destination and credential are fixed by deployment configuration. The existing ERP `transferId` contract remains unchanged.

**Tech Stack:** TypeScript, Bun, Hono, Drizzle/PostgreSQL, React, Zod, Docker Compose, existing Netsfera ERP MCP/HTTP transfer API.

**Spec:** `docs/superpowers/specs/2026-09-08-inter-agent-file-attachments-design.md`

## Global Constraints

- Keep Bot workspaces isolated; do not add a shared volume or mount one Bot's workspace into another.
- Permit PDF, JPEG, PNG, WebP, UTF-8 text, and CSV only; limit each file to 10 MiB, each handoff to 10 files and 25 MiB.
- Never place bytes, base64, credentials, absolute paths, or arbitrary URLs in model-visible values.
- Destination filenames and paths are server generated under `inbox/<handoffId>/<attachmentId>/`.
- Refuse absolute paths, traversal, symlinks, non-regular files, MIME/magic mismatches, changed bytes, and replay with a different hash.
- Preserve the existing typed `message_bot` fields and Bot-to-Bot grant checks.
- Reuse the existing ERP `erp_documents_reserve_upload`, authenticated `PUT /api/agent-transfers/:transferId`, `erp_documents_transfer_status`, and `erp_expenses_ingest` contracts.
- Gate the feature with `HANDOFF_ATTACHMENTS_ENABLED=false`; keep cleanup dry-run until the production canary passes.
- Use test-first development for every behavior change.

---

### Task 1: Confined binary workspace operations

**Files:**
- Create: `agent-computer/src/file-attachments.ts`
- Create: `agent-computer/tests/file-attachments.test.ts`
- Modify: `agent-computer/src/workspace.ts`
- Modify: `agent-computer/src/index.ts`
- Modify: `agent-computer/src/authorisation.ts`

**Interfaces:**
- Produces: `inspectAttachmentFile(workspace, path): Promise<AttachmentFile>` where `AttachmentFile` carries `filename`, `mediaType`, `sizeBytes`, `sha256`, and a confined real path used only inside Agent Computer.
- Produces: `importAttachment(workspace, input, body): Promise<ImportedAttachment>` and `deleteInboxAttachment(workspace, input): Promise<{deleted:boolean}>`.
- Produces internal routes `POST /files/attachments/export`, `POST /files/attachments/import`, and `POST /files/attachments/delete`.

- [ ] **Step 1: Write failing filesystem tests**

```ts
test("exports a real PDF with independently derived metadata", async () => {
  await writeFile(join(root, "downloads/invoice.pdf"), pdfBytes);
  const result = await inspectAttachmentFile(workspace, "downloads/invoice.pdf");
  expect(result).toMatchObject({
    filename: "invoice.pdf",
    mediaType: "application/pdf",
    sizeBytes: pdfBytes.length,
    sha256: createHash("sha256").update(pdfBytes).digest("hex"),
  });
});

test.each(["../secret.pdf", "/etc/passwd", "downloads/link.pdf"])(
  "refuses an unsafe export path %s",
  async (path) => expect(inspectAttachmentFile(workspace, path)).rejects.toThrow(),
);

test("imports atomically beneath a server-generated inbox path", async () => {
  const result = await importAttachment(workspace, metadata, stream(pdfBytes));
  expect(result.path).toBe(`inbox/${handoffId}/${attachmentId}/invoice.pdf`);
  expect(await readFile(join(root, result.path))).toEqual(pdfBytes);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test agent-computer/tests/file-attachments.test.ts`

Expected: FAIL because `file-attachments.ts` and its exports do not exist.

- [ ] **Step 3: Implement strict metadata and magic-byte validation**

```ts
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ALLOWED_ATTACHMENT_TYPES = new Set([
  "application/pdf", "image/jpeg", "image/png", "image/webp", "text/plain", "text/csv",
]);

export type AttachmentMetadata = {
  handoffId: string;
  attachmentId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
};
```

Use `workspace.resolvePath(path, false)`, `lstat`, bounded reads, literal magic-byte checks, and
`createHash("sha256")`. Refuse symlinks even when they resolve inside the workspace. Sanitize the
basename rather than accepting a destination name from the caller.

- [ ] **Step 4: Implement atomic import and exact inbox deletion**

Write to `<filename>.partial`, enforce the declared byte count while reading, recompute the hash and
MIME, then `rename` atomically. `deleteInboxAttachment` must derive the path from validated UUID-like
ids plus stored filename and refuse anything outside `inbox`.

- [ ] **Step 5: Register authenticated internal routes**

Export responds with the bounded file body and `x-openbot-attachment-*` headers. Import accepts only
server-generated identity headers and a body. Add import/delete to `ACTING_PATHS`; export remains a
read. Reuse `fileStatus` and never include absolute paths in JSON errors.

- [ ] **Step 6: Run tests and commit**

Run: `bun test agent-computer/tests/file-attachments.test.ts agent-computer/tests/workspace.test.ts agent-computer/tests/authorisation.test.ts`

Expected: PASS.

```bash
git add agent-computer/src agent-computer/tests
git commit -m "feat(computer): add confined attachment transfer"
```

### Task 2: Server-side computer-to-computer broker

**Files:**
- Create: `server/src/computer/attachments.ts`
- Create: `server/tests/computer-attachments.test.ts`
- Modify: `server/src/computer/client.ts`
- Modify: `server/src/computer/gateway.ts`
- Modify: `server/src/computer/schema.ts`

**Interfaces:**
- Consumes Agent Computer attachment routes from Task 1.
- Produces `ComputerAttachmentBroker.copy(input): Promise<HandoffAttachment[]>`, `remove(input)`, and `upload(input)`.
- Produces `HandoffAttachment` with only `id`, `filename`, `mediaType`, `sizeBytes`, `sha256`, and recipient-relative `path`.

- [ ] **Step 1: Write failing broker tests**

```ts
test("copies bytes between separately located Bot computers", async () => {
  const copied = await broker.copy({
    handoffId, fromBotId: "collector", toBotId: "erp", paths: ["downloads/invoice.pdf"],
  });
  expect(copied).toEqual([{ id: expect.any(String), filename: "invoice.pdf",
    mediaType: "application/pdf", sizeBytes: pdf.length, sha256, path: expect.stringMatching(/^inbox\//) }]);
  expect(requests.map((r) => r.botId)).toEqual(["collector", "erp"]);
});

test("rolls back earlier copies when a later attachment fails", async () => {
  await expect(broker.copy(batchWithInvalidSecondFile)).rejects.toThrow();
  expect(importedFiles).toEqual([]);
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test server/tests/computer-attachments.test.ts`

Expected: FAIL because the broker does not exist.

- [ ] **Step 3: Add a raw-response transport seam**

Add `request(...) => Promise<Response>` to `ComputerTransport`. Keep `call<T>` as the JSON wrapper so
existing callers remain unchanged. The raw seam must still add the computer token and Bot id, enforce
the timeout, validate the located address, and map non-success responses without echoing binary data.

- [ ] **Step 4: Implement bounded copy and rollback**

`copy` locates source and target independently, exports one file at a time, validates response
headers, enforces 25 MiB cumulative size, imports into the target, and returns metadata only. On any
failure it removes every target file copied during that attempt.

- [ ] **Step 5: Run tests and commit**

Run: `bun test server/tests/computer-attachments.test.ts server/tests/computer-gateway.test.ts`

Expected: PASS.

```bash
git add server/src/computer server/tests/computer-attachments.test.ts server/tests/computer-gateway.test.ts
git commit -m "feat(server): broker files between Bot computers"
```

### Task 3: Durable attachment metadata

**Files:**
- Create: `server/src/db/schema/handoff-attachments.ts`
- Create: `server/src/agents/handoff-attachment-store.ts`
- Create: `server/tests/handoff-attachment-store.integration.test.ts`
- Create: `server/drizzle/0028_handoff_attachments.sql`
- Modify: `server/src/db/schema/index.ts`
- Modify: `server/drizzle/meta/_journal.json`

**Interfaces:**
- Produces `HandoffAttachmentStore.recordBatch`, `forHandoff`, `ownedByRecipient`, `markTransferred`, `markDeleted`, and `expired`.
- States: `copied`, `transferred`, `failed`, `rejected`, `expired`, `deleted`.

- [ ] **Step 1: Write failing database tests**

```ts
test("a recipient can resolve only its own copied attachment", async () => {
  await store.recordBatch({ handoffId, fromBotId: "collector", toBotId: "erp", attachments: [attachment] });
  expect(await store.ownedByRecipient(attachment.id, "erp")).toMatchObject({ sha256 });
  expect(await store.ownedByRecipient(attachment.id, "other")).toBeNull();
});

test("state changes cannot revive a deleted attachment", async () => {
  await store.markDeleted(attachment.id, "ingested");
  await expect(store.markTransferred(attachment.id, "erp-transfer")).rejects.toThrow();
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test server/tests/handoff-attachment-store.integration.test.ts`

Expected: FAIL because the table and store do not exist.

- [ ] **Step 3: Add schema and migration**

Use text ids, foreign keys to `agents.id`, unique `(handoff_id, sha256, recipient_bot_id)`, a state
enum, relative recipient path, metadata fields, `expires_at`, `deleted_at`, and timestamps. Add an
index on `(state, expires_at)` for cleanup. Do not store source paths or bytes.

- [ ] **Step 4: Implement conditional state transitions**

All ownership reads include recipient Bot id. State writes use `WHERE id = ? AND state IN (...)`; an
empty returning set is a stale transition, not success.

- [ ] **Step 5: Run tests and commit**

Run: `bun test server/tests/handoff-attachment-store.integration.test.ts server/tests/schema.test.ts server/tests/migration-journal.test.ts`

Expected: PASS against the isolated OpenBot test database.

```bash
git add server/src/db server/src/agents/handoff-attachment-store.ts server/tests server/drizzle
git commit -m "feat(server): persist handoff attachment metadata"
```

### Task 4: Attach files to `message_bot`

**Files:**
- Modify: `server/src/agents/handoff-tool.ts`
- Modify: `server/src/agents/handoff.ts`
- Modify: `server/src/agents/handoff-runner.ts`
- Modify: `server/src/index.ts`
- Modify: `server/tests/agent-handoff-tool.test.ts`
- Modify: `server/tests/agent-handoff.test.ts`
- Modify: `server/tests/agent-handoff-runner.test.ts`
- Modify: `server/tests/agent-handoff-endtoend.integration.test.ts`

**Interfaces:**
- Consumes `ComputerAttachmentBroker` and `HandoffAttachmentStore`.
- Extends `HandoffEnvelope` with `attachments?: {path:string}[]`.
- Extends `HandoffWork` with `attachments?: HandoffAttachment[]`.

- [ ] **Step 1: Write failing tool-contract tests**

```ts
expect(parameters.safeParse({ bot: "Jefe ERP", task: "Process invoices",
  attachments: [{ path: "downloads/invoice.pdf" }] }).success).toBe(true);
expect(parameters.safeParse({ bot: "Jefe ERP", task: "x",
  attachments: Array.from({ length: 11 }, (_, i) => ({ path: `f${i}.pdf` })) }).success).toBe(false);
```

- [ ] **Step 2: Write failing handoff behavior tests**

Assert that grant checks occur before copying, the queue key includes normalized attachment paths,
copy failure queues nothing, successful manifests—not source paths—enter `work_items`, and repeated
calls reuse identical attachment copies.

- [ ] **Step 3: Verify RED**

Run: `bun test server/tests/agent-handoff-tool.test.ts server/tests/agent-handoff.test.ts server/tests/agent-handoff-runner.test.ts`

Expected: FAIL on the missing attachment contract and broker calls.

- [ ] **Step 4: Implement attachment preparation and durable handoff**

After actor, target, visibility, and grant checks, derive the deterministic handoff key including
attachment paths. Copy and record the batch before `queue.offer`. If the queue refuses because of the
fan-out cap, delete only copies created by this new attempt. A duplicate offer returns the existing
recorded manifest without creating another copy.

- [ ] **Step 5: Attribute attachments to the receiving Bot**

Append a compact block to `attribute(work)`:

```text
Files attached by collector:
- Invoice-0016.pdf — application/pdf — 195234 bytes — sha256 ab12…ef90 — inbox/…/Invoice-0016.pdf
```

Do not include source paths, absolute paths, or content. Extend `summarise` only with the attachment
count.

- [ ] **Step 6: Run tests and commit**

Run: `bun test server/tests/agent-handoff*.test.ts server/tests/agent-handoff*.integration.test.ts`

Expected: PASS.

```bash
git add server/src/agents server/src/index.ts server/tests/agent-handoff*
git commit -m "feat(handoff): deliver verified file attachments"
```

### Task 5: Render handoff attachments

**Files:**
- Modify: `app/src/lib/copilot/handoff-tool.tsx`
- Create: `app/src/lib/copilot/handoff-tool.test.tsx`

**Interfaces:**
- Consumes the model-visible `attachments: {path:string}[]` call arguments and safe server result.
- Renders filenames and counts without attempting to fetch file bytes in the browser.

- [ ] **Step 1: Write the failing renderer test**

Render an accepted `message_bot` call with two attachment paths and assert the UI shows
`Invoice-0015.pdf`, `Invoice-0016.pdf`, and `2 files`, while it does not show a source directory or
any body data.

- [ ] **Step 2: Verify RED**

Run: `bun test app/src/lib/copilot/handoff-tool.test.tsx`

Expected: FAIL because attachments are ignored.

- [ ] **Step 3: Extend the schema and renderer**

Add `attachments: z.array(z.object({ path: z.string() })).max(10).optional()` and render basenames
only. Keep refusal and running behavior unchanged.

- [ ] **Step 4: Run tests and commit**

Run: `bun test app/src/lib/copilot/handoff-tool.test.tsx app/tests/repair-history.test.ts`

Expected: PASS.

```bash
git add app/src/lib/copilot/handoff-tool.tsx app/src/lib/copilot/handoff-tool.test.tsx
git commit -m "feat(app): show files on Bot handoffs"
```

### Task 6: Transfer an inbox attachment to a fixed ERP destination

**Files:**
- Create: `server/src/agents/attachment-transfer-tool.ts`
- Create: `server/src/computer/upload-target.ts`
- Create: `server/tests/attachment-transfer-tool.test.ts`
- Create: `server/tests/computer-upload-target.test.ts`
- Modify: `server/src/config.ts`
- Modify: `server/src/index.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces `transfer_workspace_file({destination, transferId, attachmentId})`.
- Produces `WorkspaceUploadTarget = {id, origin, bearerToken, pathFor(transferId):string}` from server-only configuration.
- Consumes the existing ERP `PUT /api/agent-transfers/<uuid>` response.

- [ ] **Step 1: Write failing destination validation tests**

```ts
test.each(["http://erp.test", "https://user:pass@erp.test", "https://erp.test/path"])(
  "rejects unsafe origin %s", (origin) => expect(() => parseTarget(origin, token)).toThrow(),
);
test("derives the only permitted ERP path", () => {
  expect(target.pathFor(transferId)).toBe(`/api/agent-transfers/${transferId}`);
});
```

- [ ] **Step 2: Write failing tool tests**

Assert recipient ownership, UUID validation, HTTPS-only fixed origin, authorization from server
configuration, content-type/content-length forwarding, no redirects, no response-body return,
sanitized errors, and that a successful upload marks the attachment transferred without deleting it
before durable ERP ingestion is confirmed.

- [ ] **Step 3: Verify RED**

Run: `bun test server/tests/computer-upload-target.test.ts server/tests/attachment-transfer-tool.test.ts`

Expected: FAIL because the target and tool do not exist.

- [ ] **Step 4: Implement server-only destination configuration**

Read these optional variables:

```text
WORKSPACE_TRANSFER_NETSFERA_ERP_ORIGIN=https://erp.netsfera.es
WORKSPACE_TRANSFER_NETSFERA_ERP_TOKEN_FILE=/run/secrets/netsfera-erp-agent-token
```

The token is read from the mode-restricted file at boot, never from a tool argument. If either field
is missing or invalid, do not offer the tool. Validate the origin as HTTPS with `/`, no credentials,
query, or fragment.

- [ ] **Step 5: Implement the governed tool**

The input schema uses `destination: z.literal("netsfera-erp")`, UUID `transferId`, and UUID
`attachmentId`. Resolve the attachment by current `from.botId`, export its exact recipient path,
compare exported metadata with the database row, and PUT the bytes to the derived path. Return only:

```ts
{ attachmentId, transferId, status: "UPLOADED", sha256, sizeBytes }
```

Record a sanitized audit event. Mark `transferred`; do not delete yet because
`erp_expenses_ingest` remains a separate existing MCP call. A later explicit completion call can
mark/delete after the ERP returns `invoiceId` or `isDuplicate`.

- [ ] **Step 6: Run tests and commit**

Run: `bun test server/tests/computer-upload-target.test.ts server/tests/attachment-transfer-tool.test.ts server/tests/config.test.ts`

Expected: PASS.

```bash
git add server/src/agents/attachment-transfer-tool.ts server/src/computer/upload-target.ts server/src/config.ts server/src/index.ts server/tests .env.example
git commit -m "feat(server): upload handoff files to fixed connectors"
```

### Task 7: Completion, deletion, and expiry

**Files:**
- Create: `server/src/agents/attachment-cleanup.ts`
- Create: `server/tests/attachment-cleanup.test.ts`
- Modify: `server/src/agents/attachment-transfer-tool.ts`
- Modify: `server/src/index.ts`

**Interfaces:**
- Adds `complete_workspace_file_transfer({attachmentId, transferId, outcome, erpReference})` where
  `outcome` is `ingested`, `exact_duplicate`, `rejected`, `failed`, or `stale`.
- Produces a durable `bot.attachment.cleanup` work item for each copied attachment.

- [ ] **Step 1: Write failing lifecycle tests**

Assert that `ingested`, `exact_duplicate`, and `rejected` delete the exact inbox copy and retain
metadata; `failed` and `stale` retain bytes; expiry deletes at 30 days; repeated completion is
idempotent; and an ERP reference cannot complete another attachment.

- [ ] **Step 2: Verify RED**

Run: `bun test server/tests/attachment-cleanup.test.ts`

Expected: FAIL because completion and cleanup do not exist.

- [ ] **Step 3: Implement completion and durable cleanup**

Schedule `bot.attachment.cleanup` at `expiresAt` when recording a copy. The runner claims, deletes
through the broker, conditionally marks the row expired/deleted, and finishes the work item. Cleanup
dry-run records what it would delete and reschedules without deleting.

- [ ] **Step 4: Wire Jefe ERP's operational instructions**

Update the deployment skill/configuration so Jefe ERP:

1. reserves using attachment filename, MIME, size, and SHA-256;
2. asks the person to approve the exact selected rows;
3. calls `transfer_workspace_file` with the returned transfer id;
4. checks `erp_documents_transfer_status`;
5. calls `erp_expenses_ingest`;
6. calls `complete_workspace_file_transfer` only with the returned durable ERP result;
7. performs reconciliation through the ERP's existing reviewed proposal tools.

- [ ] **Step 5: Run tests and commit**

Run: `bun test server/tests/attachment-cleanup.test.ts server/tests/agent-handoff*.test.ts`

Expected: PASS.

```bash
git add server/src/agents server/src/index.ts server/tests
git commit -m "feat(server): expire and complete handoff files"
```

### Task 8: Cross-system verification and controlled production deployment

**Files:**
- Modify: deployment overlay under `deploy/` used by the Netsfera OpenBot service
- Modify: relevant runbook under `docs/runbooks/`
- Verify only: `/Users/xavi-mac/code/company/netsfera-erp/.worktrees/inter-agent-file-uploads`

**Interfaces:**
- Consumes all previous tasks and the existing ERP binary-transfer contract.
- Produces production evidence correlating handoff id, attachment id/hash, ERP transfer id, invoice id,
  OCR job id, and deletion state.

- [ ] **Step 1: Run the complete OpenBot verification**

Run: `bun run format:check && bun run lint && bun run typecheck && bun test`

Expected: all checks pass with no warnings introduced by this feature.

- [ ] **Step 2: Verify the existing ERP contract**

Run in the ERP worktree:

```bash
pnpm prisma:generate
pnpm exec vitest run src/modules/agent-control/__tests__/binary-transfer.test.ts --maxWorkers=2
pnpm typecheck
```

Expected: PASS. Run database integration tests only against the explicitly isolated agent test
database required by `src/test/agent-database.ts`; never point them at production.

- [ ] **Step 3: Commit documentation and deployment configuration**

```bash
git add .env.example deploy docs
git commit -m "docs: operate inter-agent file handoffs"
```

- [ ] **Step 4: Perform the OpenBot server preflight and backup**

Use `/usr/local/lib/netsfera/openbot-compose-v1.sh`, verify clean source, healthy workloads, deployed
SHA/image, and public `https://bot.netsfera.es`. Back up source and PostgreSQL under the protected
deployment backup directory and stop if the dump fails.

- [ ] **Step 5: Deploy the immutable reviewed commit with the feature disabled**

Fetch the exact SHA, build through the compose helper, restart `netsfera-openbot.service`, and repeat
container plus public health checks. Do not use bare Compose or `/opt/openbot/activate.sh`.

- [ ] **Step 6: Configure the ERP target secret and enable only the approved Bot pair**

Install the ERP principal token as a mode-0600 root-owned secret file without printing it. Enable
attachments only for `recolector-documentos` → `jefe-erp`; keep attachment cleanup dry-run.

- [ ] **Step 7: Run one production canary**

Use one known invoice: collector attaches it, Jefe ERP receives the same hash, presents one approval,
reserves and uploads, ERP reports `UPLOADED`, ingestion returns a durable invoice/duplicate result,
and completion deletes only that inbox copy. Verify the public site remains healthy.

- [ ] **Step 8: Enable cleanup and record rollback evidence**

After the audit correlation is complete, disable cleanup dry-run. Record the previous source SHA,
new SHA, image digest, backup checksum, canary ids/hashes, and the feature-disable rollback command.
