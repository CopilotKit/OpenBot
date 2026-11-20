import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  RunStatus,
  TicketRun,
  TicketRunHistoryEntry,
} from "product-engineer-loop";

export type ProductEngineerRunRow = TicketRun & {
  startedByUserId: string;
  error: string | null;
  progress: string | null;
};

function pathFor(runsDir: string, ticketId: string): string {
  const safe = ticketId
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "_");
  return join(runsDir, `${safe}.json`);
}

async function readRow(
  runsDir: string,
  ticketId: string,
): Promise<ProductEngineerRunRow | null> {
  try {
    const raw = await readFile(pathFor(runsDir, ticketId), "utf8");
    return JSON.parse(raw) as ProductEngineerRunRow;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeRow(
  runsDir: string,
  run: ProductEngineerRunRow,
): Promise<ProductEngineerRunRow> {
  await mkdir(runsDir, { recursive: true });
  const next = { ...run, updatedAt: new Date().toISOString() };
  await writeFile(
    pathFor(runsDir, run.ticketId),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  return next;
}

export type ProductEngineerStore = {
  list(): Promise<ProductEngineerRunRow[]>;
  get(ticketId: string): Promise<ProductEngineerRunRow | null>;
  insert(input: {
    ticketId: string;
    linearIssueId: string;
    title: string;
    linearUrl: string;
    status: RunStatus;
    repos: string[];
    startedByUserId: string;
    plan?: string | null;
    history?: TicketRunHistoryEntry[];
  }): Promise<ProductEngineerRunRow>;
  save(
    run: TicketRun & {
      error?: string | null;
      plan?: string | null;
      startedByUserId?: string;
    },
  ): Promise<ProductEngineerRunRow>;
  setStatus(
    ticketId: string,
    status: RunStatus,
    patch?: {
      error?: string | null;
      agentId?: string;
      plan?: string | null;
      progress?: string | null;
    },
  ): Promise<ProductEngineerRunRow | null>;
  updateLive(
    ticketId: string,
    patch: {
      agentId?: string;
      lastRunId?: string | null;
      progress?: string;
    },
  ): Promise<ProductEngineerRunRow | null>;
};

/** JSON-file store under PE_RUNS_DIR. One file per Linear ticket id. */
export function createProductEngineerStore(
  runsDir: string,
): ProductEngineerStore {
  return {
    async list() {
      await mkdir(runsDir, { recursive: true });
      const names = await readdir(runsDir);
      const rows: ProductEngineerRunRow[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        try {
          const raw = await readFile(join(runsDir, name), "utf8");
          rows.push(JSON.parse(raw) as ProductEngineerRunRow);
        } catch {
          // Skip corrupt files; list still returns the rest.
        }
      }
      return rows
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 50);
    },

    async get(ticketId) {
      return readRow(runsDir, ticketId);
    },

    async insert(input) {
      const now = new Date().toISOString();
      return writeRow(runsDir, {
        ticketId: input.ticketId,
        linearIssueId: input.linearIssueId,
        title: input.title,
        linearUrl: input.linearUrl,
        agentId: "",
        lastRunId: null,
        status: input.status,
        repos: input.repos,
        prUrl: null,
        createdAt: now,
        updatedAt: now,
        history: input.history ?? [],
        plan: input.plan ?? null,
        error: null,
        progress: null,
        startedByUserId: input.startedByUserId,
      });
    },

    async save(run) {
      const prior = await readRow(runsDir, run.ticketId);
      if (!prior) {
        throw new Error(`No product engineer run for ${run.ticketId}.`);
      }
      return writeRow(runsDir, {
        ...prior,
        ...run,
        error: run.error ?? null,
        progress: run.progress ?? prior.progress ?? null,
        plan: run.plan ?? prior.plan ?? null,
        startedByUserId: run.startedByUserId ?? prior.startedByUserId,
      });
    },

    async setStatus(ticketId, status, patch = {}) {
      const prior = await readRow(runsDir, ticketId);
      if (!prior) return null;
      return writeRow(runsDir, {
        ...prior,
        status,
        error: patch.error !== undefined ? patch.error : prior.error,
        agentId: patch.agentId !== undefined ? patch.agentId : prior.agentId,
        plan: patch.plan !== undefined ? patch.plan : prior.plan,
        progress:
          patch.progress !== undefined ? patch.progress : prior.progress,
      });
    },

    async updateLive(ticketId, patch) {
      const prior = await readRow(runsDir, ticketId);
      if (!prior) return null;
      return writeRow(runsDir, {
        ...prior,
        agentId: patch.agentId !== undefined ? patch.agentId : prior.agentId,
        lastRunId:
          patch.lastRunId !== undefined ? patch.lastRunId : prior.lastRunId,
        progress:
          patch.progress !== undefined ? patch.progress : prior.progress,
      });
    },
  };
}
