import { Database } from "bun:sqlite";

export type RunState =
  | "queued"
  | "preparing"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export interface CommitMetadata {
  hash: string;
  subject: string;
  parents?: readonly string[];
  authorName?: string;
  authorEmail?: string;
  authoredAt?: string;
}

export interface StoredRun {
  provider: string;
  runId: string;
  threadId: string;
  state: RunState;
  workspacePath?: string;
  providerSessionId?: string;
  acknowledgedMessageId?: string;
  errorSummary?: string;
  patch?: string;
  baseCommit?: string;
  commits: CommitMetadata[];
  createdAt: number;
  updatedAt: number;
}

export interface StoredSession {
  provider: string;
  threadId: string;
  sessionId: string;
  acknowledgedMessageId?: string;
  updatedAt: number;
}

interface RunRow {
  provider: string;
  run_id: string;
  thread_id: string;
  state: RunState;
  workspace_path: string | null;
  provider_session_id: string | null;
  acknowledged_message_id: string | null;
  error_summary: string | null;
  patch: string | null;
  base_commit: string | null;
  commits_json: string;
  created_at: number;
  updated_at: number;
}

interface SessionRow {
  provider: string;
  thread_id: string;
  session_id: string;
  acknowledged_message_id: string | null;
  updated_at: number;
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const INTERRUPTED_STATES: readonly RunState[] = [
  "queued",
  "preparing",
  "running",
  "cancelling",
];
const NEXT_STATES: Record<RunState, readonly RunState[]> = {
  queued: ["preparing", "failed", "cancelled"],
  preparing: ["running", "failed", "cancelled"],
  running: ["cancelling", "completed", "failed", "cancelled"],
  cancelling: ["cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

function requireId(label: string, value: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`Invalid ${label}.`);
}

function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

function parseCommits(value: string): CommitMetadata[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as CommitMetadata[]) : [];
  } catch {
    return [];
  }
}

function storedRun(row: RunRow): StoredRun {
  return {
    provider: row.provider,
    runId: row.run_id,
    threadId: row.thread_id,
    state: row.state,
    ...(row.workspace_path ? { workspacePath: row.workspace_path } : {}),
    ...(row.provider_session_id
      ? { providerSessionId: row.provider_session_id }
      : {}),
    ...(row.acknowledged_message_id
      ? { acknowledgedMessageId: row.acknowledged_message_id }
      : {}),
    ...(row.error_summary ? { errorSummary: row.error_summary } : {}),
    ...(row.patch !== null ? { patch: row.patch } : {}),
    ...(row.base_commit ? { baseCommit: row.base_commit } : {}),
    commits: parseCommits(row.commits_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class RunStore {
  readonly path: string;
  private readonly database: Database;

  constructor(path: string) {
    this.path = path;
    this.database = new Database(path, { create: true });
    this.database.run("PRAGMA journal_mode = WAL");
    this.database.run("PRAGMA foreign_keys = ON");
    this.database.run("PRAGMA busy_timeout = 5000");
    this.database.run(`
      CREATE TABLE IF NOT EXISTS runs (
        provider TEXT NOT NULL,
        run_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        state TEXT NOT NULL,
        workspace_path TEXT,
        provider_session_id TEXT,
        acknowledged_message_id TEXT,
        error_summary TEXT,
        patch TEXT,
        base_commit TEXT,
        commits_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, run_id)
      )
    `);
    this.database.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        provider TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        acknowledged_message_id TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, thread_id)
      )
    `);
    this.database.run(`
      CREATE TABLE IF NOT EXISTS host_leases (
        owner TEXT PRIMARY KEY,
        acquired_at INTEGER NOT NULL
      )
    `);
  }

  reserveRun(input: { provider: string; runId: string; threadId: string }): {
    created: boolean;
    run: StoredRun;
  } {
    requireId("provider", input.provider);
    requireId("run ID", input.runId);
    requireId("thread ID", input.threadId);
    return this.database.transaction(() => {
      const existing = this.getRun(input.provider, input.runId);
      if (existing) return { created: false, run: existing };
      const now = Date.now();
      this.database
        .query(
          `INSERT INTO runs
           (provider, run_id, thread_id, state, created_at, updated_at)
           VALUES (?, ?, ?, 'queued', ?, ?)`,
        )
        .run(input.provider, input.runId, input.threadId, now, now);
      const run = this.getRun(input.provider, input.runId);
      if (!run) throw new Error("Failed to reserve the run.");
      return { created: true, run };
    })();
  }

  getRun(provider: string, runId: string): StoredRun | undefined {
    const row = this.database
      .query("SELECT * FROM runs WHERE provider = ? AND run_id = ?")
      .get(provider, runId) as RunRow | null;
    return row ? storedRun(row) : undefined;
  }

  listRuns(): StoredRun[] {
    return (
      this.database
        .query("SELECT * FROM runs ORDER BY created_at, provider, run_id")
        .all() as RunRow[]
    ).map(storedRun);
  }

  transitionRun(
    provider: string,
    runId: string,
    next: RunState,
    allowedFrom: readonly RunState[],
    options: { errorSummary?: string } = {},
  ): StoredRun {
    if (allowedFrom.length === 0)
      throw new Error("A guarded transition needs a source state.");
    if (allowedFrom.some((state) => !NEXT_STATES[state].includes(next))) {
      throw new Error(`Invalid run transition to ${next}.`);
    }
    const placeholders = allowedFrom.map(() => "?").join(", ");
    const now = Date.now();
    const result = this.database
      .query(
        `UPDATE runs
         SET state = ?, error_summary = COALESCE(?, error_summary), updated_at = ?
         WHERE provider = ? AND run_id = ? AND state IN (${placeholders})`,
      )
      .run(
        next,
        options.errorSummary ?? null,
        now,
        provider,
        runId,
        ...allowedFrom,
      );
    if (result.changes !== 1) {
      throw new Error(`Invalid run transition to ${next}.`);
    }
    const run = this.getRun(provider, runId);
    if (!run) throw new Error("Run disappeared after transition.");
    return run;
  }

  attachWorkspace(
    provider: string,
    runId: string,
    workspacePath: string,
  ): void {
    const result = this.database
      .query(
        "UPDATE runs SET workspace_path = ?, updated_at = ? WHERE provider = ? AND run_id = ?",
      )
      .run(workspacePath, Date.now(), provider, runId);
    if (result.changes !== 1) throw new Error("Unknown run.");
  }

  saveResult(
    provider: string,
    runId: string,
    result: {
      patch: string;
      baseCommit: string;
      commits: readonly CommitMetadata[];
    },
  ): void {
    const updated = this.database
      .query(
        `UPDATE runs
         SET patch = ?, base_commit = ?, commits_json = ?, updated_at = ?
         WHERE provider = ? AND run_id = ?`,
      )
      .run(
        result.patch,
        result.baseCommit,
        JSON.stringify(result.commits),
        Date.now(),
        provider,
        runId,
      );
    if (updated.changes !== 1) throw new Error("Unknown run.");
  }

  saveSession(input: {
    provider: string;
    threadId: string;
    sessionId: string;
    acknowledgedMessageId?: string;
  }): void {
    requireId("provider", input.provider);
    requireId("thread ID", input.threadId);
    requireId("provider session ID", input.sessionId);
    if (input.acknowledgedMessageId) {
      requireId("acknowledged message ID", input.acknowledgedMessageId);
    }
    this.database
      .query(
        `INSERT INTO sessions
          (provider, thread_id, session_id, acknowledged_message_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider, thread_id) DO UPDATE SET
          session_id = excluded.session_id,
          acknowledged_message_id = excluded.acknowledged_message_id,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.provider,
        input.threadId,
        input.sessionId,
        input.acknowledgedMessageId ?? null,
        Date.now(),
      );
  }

  getSession(provider: string, threadId: string): StoredSession | undefined {
    const row = this.database
      .query("SELECT * FROM sessions WHERE provider = ? AND thread_id = ?")
      .get(provider, threadId) as SessionRow | null;
    if (!row || !SAFE_ID.test(row.session_id)) return undefined;
    const acknowledgedMessageId = optional(row.acknowledged_message_id);
    return {
      provider: row.provider,
      threadId: row.thread_id,
      sessionId: row.session_id,
      ...(acknowledgedMessageId ? { acknowledgedMessageId } : {}),
      updatedAt: row.updated_at,
    };
  }

  acknowledgeRun(input: {
    provider: string;
    runId: string;
    sessionId: string;
    acknowledgedMessageId?: string;
  }): void {
    const run = this.getRun(input.provider, input.runId);
    if (!run) throw new Error("Unknown run.");
    this.database.transaction(() => {
      this.saveSession({
        provider: input.provider,
        threadId: run.threadId,
        sessionId: input.sessionId,
        ...(input.acknowledgedMessageId
          ? { acknowledgedMessageId: input.acknowledgedMessageId }
          : {}),
      });
      this.database
        .query(
          `UPDATE runs SET provider_session_id = ?, acknowledged_message_id = ?, updated_at = ?
           WHERE provider = ? AND run_id = ?`,
        )
        .run(
          input.sessionId,
          input.acknowledgedMessageId ?? null,
          Date.now(),
          input.provider,
          input.runId,
        );
    })();
  }

  recoverInterrupted(errorSummary: string, provider?: string): number {
    const placeholders = INTERRUPTED_STATES.map(() => "?").join(", ");
    return this.database.transaction(() => {
      const providerClause = provider ? " AND provider = ?" : "";
      const result = this.database
        .query(
          `UPDATE runs SET state = 'failed', error_summary = ?, updated_at = ?
           WHERE state IN (${placeholders})${providerClause}`,
        )
        .run(
          errorSummary,
          Date.now(),
          ...INTERRUPTED_STATES,
          ...(provider ? [provider] : []),
        );
      if (provider) {
        this.database
          .query("DELETE FROM host_leases WHERE owner LIKE ?")
          .run(`${provider}:%`);
      } else {
        this.database.run("DELETE FROM host_leases");
      }
      return result.changes;
    })();
  }

  tryAcquireHostLease(owner: string, limit: number): boolean {
    requireId("host lease owner", owner);
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error("Invalid host lease limit.");
    return this.database.transaction(() => {
      const existing = this.database
        .query("SELECT owner FROM host_leases WHERE owner = ?")
        .get(owner);
      if (existing) return true;
      const count = this.database
        .query("SELECT COUNT(*) AS count FROM host_leases")
        .get() as {
        count: number;
      };
      if (count.count >= limit) return false;
      this.database
        .query("INSERT INTO host_leases (owner, acquired_at) VALUES (?, ?)")
        .run(owner, Date.now());
      return true;
    })();
  }

  releaseHostLease(owner: string): void {
    this.database.query("DELETE FROM host_leases WHERE owner = ?").run(owner);
  }

  listWorkspaceCleanupCandidates(before: number): StoredRun[] {
    return (
      this.database
        .query(
          `SELECT * FROM runs
           WHERE workspace_path IS NOT NULL
             AND state IN ('completed', 'failed', 'cancelled')
             AND updated_at < ?
           ORDER BY updated_at, provider, run_id`,
        )
        .all(before) as RunRow[]
    ).map(storedRun);
  }

  clearWorkspace(
    provider: string,
    runId: string,
    workspacePath: string,
  ): boolean {
    const result = this.database
      .query(
        `UPDATE runs SET workspace_path = NULL, updated_at = ?
         WHERE provider = ? AND run_id = ? AND workspace_path = ?
           AND state IN ('completed', 'failed', 'cancelled')`,
      )
      .run(Date.now(), provider, runId, workspacePath);
    return result.changes === 1;
  }

  close(): void {
    this.database.close();
  }
}
