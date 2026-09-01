import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type ThreadState = {
  version: 1;
  threads: Record<string, string>;
  catalogues?: Record<string, string>;
};

const EMPTY_STATE: ThreadState = { version: 1, threads: {} };

/**
 * The durable join between an OpenBot Intelligence thread and its Codex app-server thread.
 *
 * Codex persists its own rollout, but it cannot know which OpenBot thread owns it. This small file is
 * the missing half. Writes replace the file atomically, so killing the adapter during a write leaves
 * either the previous complete mapping or the next one, never half a JSON document.
 */
export class CodexThreadStore {
  private readonly threads: Map<string, string>;
  private readonly catalogues: Map<string, string>;
  private writes = Promise.resolve();

  private constructor(
    private readonly path: string,
    state: ThreadState,
  ) {
    this.threads = new Map(Object.entries(state.threads));
    this.catalogues = new Map(Object.entries(state.catalogues ?? {}));
  }

  static async open(path: string): Promise<CodexThreadStore> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new CodexThreadStore(path, EMPTY_STATE);
      }
      throw error;
    }

    return new CodexThreadStore(path, parseState(raw, path));
  }

  get(openbotThreadId: string): string | undefined {
    return this.threads.get(openbotThreadId);
  }

  catalogue(openbotThreadId: string): string | undefined {
    return this.catalogues.get(openbotThreadId);
  }

  size(): number {
    return this.threads.size;
  }

  async remember(
    openbotThreadId: string,
    codexThreadId: string,
    catalogue?: string,
  ): Promise<void> {
    if (!openbotThreadId || !codexThreadId) {
      throw new Error("Thread ids must not be empty.");
    }
    if (catalogue !== undefined && !catalogue) {
      throw new Error("A tool catalogue fingerprint must not be empty.");
    }
    const write = this.writes
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
        const nextThreads = new Map(this.threads);
        const nextCatalogues = new Map(this.catalogues);
        nextThreads.set(openbotThreadId, codexThreadId);
        if (catalogue === undefined) nextCatalogues.delete(openbotThreadId);
        else nextCatalogues.set(openbotThreadId, catalogue);
        const state: ThreadState = {
          version: 1,
          threads: Object.fromEntries(nextThreads),
          ...(nextCatalogues.size > 0
            ? { catalogues: Object.fromEntries(nextCatalogues) }
            : {}),
        };
        try {
          await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });
          await rename(temporary, this.path);
          this.threads.set(openbotThreadId, codexThreadId);
          if (catalogue === undefined) this.catalogues.delete(openbotThreadId);
          else this.catalogues.set(openbotThreadId, catalogue);
        } catch (error) {
          await unlink(temporary).catch(() => {});
          throw error;
        }
      });
    this.writes = write;
    await write;
  }
}

function parseState(raw: string, path: string): ThreadState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      `Codex thread state at ${path} is not valid JSON. Refusing to forget existing conversations.`,
    );
  }

  if (!isObject(value) || value.version !== 1 || !isObject(value.threads)) {
    throwUnsupportedState(path);
  }

  const threads = value.threads;
  const catalogues = value.catalogues;
  if (
    Object.entries(threads).some(
      ([openbotThreadId, codexThreadId]) =>
        !openbotThreadId || typeof codexThreadId !== "string" || !codexThreadId,
    ) ||
    (catalogues !== undefined &&
      (!isObject(catalogues) ||
        Object.entries(catalogues).some(
          ([openbotThreadId, catalogue]) =>
            !openbotThreadId ||
            typeof catalogue !== "string" ||
            !catalogue ||
            !(openbotThreadId in threads),
        )))
  ) {
    throwUnsupportedState(path);
  }

  return value as ThreadState;
}

function throwUnsupportedState(path: string): never {
  throw new Error(
    `Codex thread state at ${path} has an unsupported shape. Refusing to forget existing conversations.`,
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
