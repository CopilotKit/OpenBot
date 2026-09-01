import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexThreadStore } from "../src/thread-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function statePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "openbot-codex-state-"));
  temporaryDirectories.push(directory);
  return join(directory, "nested", "threads.json");
}

describe("CodexThreadStore", () => {
  test("recovers OpenBot-to-Codex joins after reopening", async () => {
    const path = await statePath();
    const store = await CodexThreadStore.open(path);
    await store.remember("openbot-1", "codex-1", "sha256:catalogue-1");

    const recovered = await CodexThreadStore.open(path);
    expect(recovered.get("openbot-1")).toBe("codex-1");
    expect(recovered.catalogue("openbot-1")).toBe("sha256:catalogue-1");
    expect(recovered.size()).toBe(1);

    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("serialises concurrent atomic writes without losing a mapping", async () => {
    const path = await statePath();
    const store = await CodexThreadStore.open(path);

    await Promise.all([
      store.remember("openbot-1", "codex-1", "catalogue-1"),
      store.remember("openbot-2", "codex-2", "catalogue-2"),
    ]);

    const state = JSON.parse(await readFile(path, "utf8")) as {
      threads: Record<string, string>;
      catalogues: Record<string, string>;
    };
    expect(state.threads).toEqual({
      "openbot-1": "codex-1",
      "openbot-2": "codex-2",
    });
    expect(state.catalogues).toEqual({
      "openbot-1": "catalogue-1",
      "openbot-2": "catalogue-2",
    });
  });

  test("loads legacy mappings without claiming their tool catalogue is current", async () => {
    const path = await statePath();
    await Bun.write(
      path,
      JSON.stringify({ version: 1, threads: { "openbot-1": "codex-1" } }),
    );

    const recovered = await CodexThreadStore.open(path);
    expect(recovered.get("openbot-1")).toBe("codex-1");
    expect(recovered.catalogue("openbot-1")).toBeUndefined();
  });

  test("refuses to silently replace corrupt recovery state", async () => {
    const path = await statePath();
    await Bun.write(path, "not json");

    await expect(CodexThreadStore.open(path)).rejects.toThrow(
      "Refusing to forget existing conversations",
    );
  });

  test("rejects unsupported state shapes", async () => {
    const path = await statePath();
    await Bun.write(path, JSON.stringify({ version: 2, threads: {} }));

    await expect(CodexThreadStore.open(path)).rejects.toThrow(
      "unsupported shape",
    );
  });

  test("rejects catalogue fingerprints that do not own a thread mapping", async () => {
    const path = await statePath();
    await Bun.write(
      path,
      JSON.stringify({
        version: 1,
        threads: {},
        catalogues: { "openbot-1": "catalogue-1" },
      }),
    );

    await expect(CodexThreadStore.open(path)).rejects.toThrow(
      "unsupported shape",
    );
  });
});
