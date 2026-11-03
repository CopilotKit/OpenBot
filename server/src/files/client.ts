/**
 * Intelligence's file store, as OpenBot calls it: chat attachments and the screenshots a Bot's
 * browser turns keep live there, under this deployment's project key. The contract is
 * Intelligence's `docs/contracts/files.md`.
 *
 * Every write carries an `Idempotency-Key`, and a request that fails on the way (the connection
 * drops, Intelligence answers 5xx) is sent again with the same key, so a retry after a lost response
 * is the same write rather than a second one. Nothing here holds a database connection: a caller
 * must never call this with an OpenBot transaction open.
 *
 * Browsers never reach this: OpenBot's own routes decide who may see a file and serve the bytes.
 * The project key stays on the server.
 */

export type FilesSettings = {
  apiUrl: string;
  apiKey: string;
  /** For tests that need to observe the transport. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
};

/** A file as Intelligence describes it. */
export type StoredFile = {
  id: string;
  purpose: string;
  ownerUserId: string | null;
  collection: string | null;
  key: string | null;
  batch: string | null;
  name: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  title: string | null;
  sourceUrl: string | null;
  committedAt: Date | null;
  expiresAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

/** What a create sends as `metadata`. */
export type NewFile = {
  id?: string;
  purpose: string;
  ownerUserId?: string | null;
  collection?: string | null;
  key?: string | null;
  batch?: string | null;
  name: string;
  contentType: string;
  title?: string | null;
  sourceUrl?: string | null;
  expiresAt?: Date | null;
  committed?: boolean;
  /** Import: when the file was committed. */
  committedAt?: Date;
  /** Import: when the file was created. */
  createdAt?: Date;
  pendingLimits?: { perBatch?: number; perOwner?: number };
};

/** Intelligence refused or could not answer. `code` is the file store's error code when it sent one. */
export class FilesError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "FilesError";
  }
}

/** A create refused by its pending limits, with the counts that refused it. */
export class PendingLimitError extends FilesError {
  constructor(
    readonly batchPending: number,
    readonly ownerPending: number,
  ) {
    super(
      `Pending limit reached (${batchPending} in the batch, ${ownerPending} for the owner).`,
      409,
      "FILE_PENDING_LIMIT_REACHED",
    );
    this.name = "PendingLimitError";
  }
}

/** Another file has this id, or this key in its purpose and collection. */
export class FileExistsError extends FilesError {
  constructor() {
    super("A different file already exists.", 409, "FILE_ALREADY_EXISTS");
    this.name = "FileExistsError";
  }
}

/** A commit could not leave every named file committed, so nothing was committed. */
export class CommitIncompleteError extends FilesError {
  constructor(readonly uncommitted: readonly string[]) {
    super(
      `These files could not be committed: ${uncommitted.join(", ")}.`,
      409,
      "FILE_COMMIT_INCOMPLETE",
    );
    this.name = "CommitIncompleteError";
  }
}

/** The file changed since it was read. */
export class FileVersionConflictError extends FilesError {
  constructor(id: string) {
    super(
      `File ${id} changed since it was read.`,
      412,
      "FILE_VERSION_CONFLICT",
    );
    this.name = "FileVersionConflictError";
  }
}

export type FilesClient = ReturnType<typeof createFilesClient>;

export type FileFilter = {
  purpose?: string;
  ownerUserId?: string;
  collection?: string;
  collectionPrefix?: string;
  key?: string;
  batch?: string;
  pending?: boolean;
};

type WireFile = Omit<
  StoredFile,
  "committedAt" | "expiresAt" | "createdAt" | "updatedAt"
> & {
  committedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 200;

/** A fresh key for one logical write. Retries of that write reuse it. */
export function filesIdempotencyKey(operation: string): string {
  return `openbot:files:${operation}:${crypto.randomUUID()}`;
}

function fileFromWire(file: WireFile): StoredFile {
  return {
    ...file,
    committedAt: file.committedAt ? new Date(file.committedAt) : null,
    expiresAt: file.expiresAt ? new Date(file.expiresAt) : null,
    createdAt: new Date(file.createdAt),
    updatedAt: new Date(file.updatedAt),
  };
}

function metadataToWire(file: NewFile): Record<string, unknown> {
  return {
    ...(file.id ? { id: file.id } : {}),
    purpose: file.purpose,
    ownerUserId: file.ownerUserId ?? null,
    collection: file.collection ?? null,
    key: file.key ?? null,
    batch: file.batch ?? null,
    name: file.name,
    contentType: file.contentType,
    title: file.title ?? null,
    sourceUrl: file.sourceUrl ?? null,
    expiresAt: file.expiresAt ? file.expiresAt.toISOString() : null,
    committed: file.committed ?? true,
    ...(file.committedAt
      ? { committedAt: file.committedAt.toISOString() }
      : {}),
    ...(file.createdAt ? { createdAt: file.createdAt.toISOString() } : {}),
    ...(file.pendingLimits ? { pendingLimits: file.pendingLimits } : {}),
  };
}

export function createFilesClient(settings: FilesSettings) {
  const base = settings.apiUrl.replace(/\/+$/, "");
  const send = settings.fetch ?? fetch;

  async function request(
    method: string,
    path: string,
    options: {
      json?: unknown;
      form?: () => FormData;
      idempotencyKey?: string;
      ifMatch?: number;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${settings.apiKey}`,
    };
    if (options.json !== undefined)
      headers["content-type"] = "application/json";
    if (options.idempotencyKey)
      headers["idempotency-key"] = options.idempotencyKey;
    if (options.ifMatch !== undefined)
      headers["if-match"] = `"${options.ifMatch}"`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const response = await send(`${base}${path}`, {
          method,
          headers,
          ...(options.json !== undefined
            ? { body: JSON.stringify(options.json) }
            : options.form
              ? { body: options.form() }
              : {}),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        // A 5xx is Intelligence failing, not refusing: the same write under the same key is safe to
        // send again, and a read is safe to repeat.
        if (response.status >= 500 && attempt < ATTEMPTS) {
          lastError = new FilesError(
            `Intelligence answered ${response.status} to ${method} ${path}.`,
            response.status,
            await errorCode(response),
          );
          await pause(attempt);
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt < ATTEMPTS) await pause(attempt);
      }
    }
    if (lastError instanceof FilesError) throw lastError;
    throw new FilesError(
      `Could not reach Intelligence for ${method} ${path}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      null,
      null,
    );
  }

  async function refusal(response: Response, what: string): Promise<never> {
    const code = await errorCode(response);
    throw new FilesError(
      `Intelligence refused to ${what}: ${response.status}${code ? ` ${code}` : ""}.`,
      response.status,
      code,
    );
  }

  const path = (id: string) => `/api/files/${encodeURIComponent(id)}`;

  return {
    /**
     * Stores a file. An identical earlier upload (same id or key, same bytes and metadata) answers
     * with that file instead.
     *
     * @throws PendingLimitError, FileExistsError, or FilesError.
     */
    async create(
      file: NewFile,
      content: Uint8Array,
      idempotencyKey: string,
    ): Promise<{ file: StoredFile; created: boolean }> {
      const metadata = JSON.stringify(metadataToWire(file));
      const response = await request("POST", "/api/files", {
        idempotencyKey,
        form: () => {
          const form = new FormData();
          form.set("metadata", metadata);
          form.set(
            "content",
            new Blob([content as Uint8Array<ArrayBuffer>], {
              type: "application/octet-stream",
            }),
            "content",
          );
          return form;
        },
      });
      if (response.status === 201 || response.status === 200) {
        return {
          file: fileFromWire((await response.json()) as WireFile),
          created: response.status === 201,
        };
      }
      const code = await errorCode(response);
      if (code === "FILE_PENDING_LIMIT_REACHED") {
        throw new PendingLimitError(
          Number(response.headers.get("x-files-batch-pending") ?? 0),
          Number(response.headers.get("x-files-owner-pending") ?? 0),
        );
      }
      if (code === "FILE_ALREADY_EXISTS") throw new FileExistsError();
      return refusal(response, `store a ${file.purpose} file`);
    },

    /** One file's metadata, or null when there is no such file (or it has expired). */
    async get(id: string): Promise<StoredFile | null> {
      const response = await request("GET", path(id));
      if (response.status === 404) return null;
      if (response.status !== 200) return refusal(response, `read file ${id}`);
      return fileFromWire((await response.json()) as WireFile);
    },

    /** One file's bytes, or null when there is no such file (or it has expired). */
    async content(id: string): Promise<Buffer | null> {
      const response = await request("GET", `${path(id)}/content`);
      if (response.status === 404) return null;
      if (response.status !== 200)
        return refusal(response, `read file ${id}'s content`);
      return Buffer.from(await response.arrayBuffer());
    },

    /** Every live file matching the filter, all pages. */
    async list(filter: FileFilter): Promise<StoredFile[]> {
      const files: StoredFile[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
        for (const [name, value] of Object.entries(filter)) {
          if (value !== undefined) query.set(name, String(value));
        }
        if (cursor) query.set("cursor", cursor);
        const response = await request("GET", `/api/files?${query.toString()}`);
        if (response.status !== 200) return refusal(response, "list files");
        const page = (await response.json()) as {
          files: WireFile[];
          nextCursor: string | null;
        };
        files.push(...page.files.map(fileFromWire));
        cursor = page.nextCursor;
      } while (cursor);
      return files;
    },

    /**
     * Commits several files, all or none: the pending ones among `ids` that match `ownerUserId`
     * and `collection` are committed, and every id must then name a committed file in `collection`.
     *
     * @throws CommitIncompleteError naming the ids that could not be, or FilesError.
     */
    async commit(
      input: {
        ids: readonly string[];
        purpose?: string;
        ownerUserId?: string;
        collection?: string;
      },
      idempotencyKey: string,
    ): Promise<StoredFile[]> {
      const response = await request("POST", "/api/files/commit", {
        json: input,
        idempotencyKey,
      });
      if (response.status === 200) {
        const body = (await response.json()) as { files: WireFile[] };
        return body.files.map(fileFromWire);
      }
      if ((await errorCode(response)) === "FILE_COMMIT_INCOMPLETE") {
        throw new CommitIncompleteError(
          (response.headers.get("x-files-uncommitted") ?? "")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean),
        );
      }
      return refusal(response, "commit files");
    },

    /**
     * Deletes one file. `version` makes it conditional: a file that changed since is not deleted.
     *
     * @returns "deleted", or "missing" when there was no such file.
     * @throws FileVersionConflictError, or FilesError.
     */
    async delete(
      id: string,
      idempotencyKey: string,
      version?: number,
    ): Promise<"deleted" | "missing"> {
      const response = await request("DELETE", path(id), {
        idempotencyKey,
        ...(version !== undefined ? { ifMatch: version } : {}),
      });
      if (response.status === 204) return "deleted";
      if (response.status === 404) return "missing";
      if (response.status === 412) throw new FileVersionConflictError(id);
      return refusal(response, `delete file ${id}`);
    },

    /** Deletes every file of one purpose in a collection, under a collection, of an owner, or older than a time. */
    async purge(filter: {
      purpose: string;
      collection?: string;
      collectionPrefix?: string;
      ownerUserId?: string;
      createdBefore?: string;
    }): Promise<number> {
      const query = new URLSearchParams();
      for (const [name, value] of Object.entries(filter)) {
        if (value !== undefined) query.set(name, value);
      }
      const response = await request(
        "DELETE",
        `/api/files?${query.toString()}`,
      );
      if (response.status !== 200) return refusal(response, "purge files");
      return ((await response.json()) as { deleted: number }).deleted;
    },
  };
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as {
      error?: { code?: unknown };
    };
    return typeof body.error?.code === "string" ? body.error.code : null;
  } catch {
    return null;
  }
}

function pause(attempt: number) {
  return new Promise((resolve) => setTimeout(resolve, 150 * attempt * attempt));
}

let installed: FilesClient | undefined;

/**
 * Makes `client` the process's file store, as `installBotDirectory` does for Bots: the attachment
 * routes, the turn's attachment loader and the page-frame store all reach Intelligence through it.
 */
export function installFilesClient(client: FilesClient): FilesClient {
  installed = client;
  return client;
}

/** The process's file store. Throws when none was installed, which is a wiring mistake. */
export function filesClient(): FilesClient {
  if (!installed) {
    throw new Error(
      "No Intelligence file store is installed. index.ts installs one at boot (installFilesClient).",
    );
  }
  return installed;
}
