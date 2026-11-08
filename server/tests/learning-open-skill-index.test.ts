import { describe, expect, test } from "bun:test";
import {
  createOpenSkillIndex,
  type OpenSkillSource,
} from "../src/learning/sharing";

/** A `read()` whose answers the test hands out one at a time, in the order the reads began. */
function controlledRead() {
  const pending: {
    resolve: (sources: OpenSkillSource[]) => void;
    reject: (error: Error) => void;
  }[] = [];
  return {
    read: () =>
      new Promise<OpenSkillSource[]>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
    get started() {
      return pending.length;
    },
    answer(index: number, sources: OpenSkillSource[]) {
      pending[index]?.resolve(sources);
    },
    fail(index: number, error: Error) {
      pending[index]?.reject(error);
    },
  };
}

const source = (userId: string): OpenSkillSource => ({
  userId,
  containerId: `personal-${userId}`,
  skills: "all",
});

describe("the open-Skill index", () => {
  test("a call made after invalidate() does not get the answer of a read that began before it", async () => {
    const reads = controlledRead();
    const index = createOpenSkillIndex({ read: reads.read });
    const before = index.sources();
    index.invalidate();
    const after = index.sources();
    expect(reads.started).toBe(2);
    reads.answer(1, [source("after")]);
    reads.answer(0, [source("before")]);
    expect(await after).toEqual([source("after")]);
    expect(await before).toEqual([source("before")]);
    // The older read finished last, but the index keeps what was read after the change.
    expect(await index.sources()).toEqual([source("after")]);
    expect(reads.started).toBe(2);
  });

  test("callers in the same generation share one read", async () => {
    const reads = controlledRead();
    const index = createOpenSkillIndex({ read: reads.read });
    const first = index.sources();
    const second = index.sources();
    index.invalidate();
    const third = index.sources();
    const fourth = index.sources();
    expect(reads.started).toBe(2);
    reads.answer(0, [source("old")]);
    reads.answer(1, [source("new")]);
    expect(await first).toEqual([source("old")]);
    expect(await second).toEqual([source("old")]);
    expect(await third).toEqual([source("new")]);
    expect(await fourth).toEqual([source("new")]);
  });

  test("a failed read keeps the last good index", async () => {
    let clock = 0;
    const reads = controlledRead();
    const index = createOpenSkillIndex({
      read: reads.read,
      ttlMs: 10,
      now: () => clock,
    });
    const first = index.sources();
    reads.answer(0, [source("good")]);
    expect(await first).toEqual([source("good")]);
    clock = 20;
    const stale = index.sources();
    expect(reads.started).toBe(2);
    reads.fail(1, new Error("database unreachable"));
    expect(await stale).toEqual([source("good")]);
  });

  test("a failed first read throws, and the next call reads again", async () => {
    const reads = controlledRead();
    const index = createOpenSkillIndex({ read: reads.read });
    const first = index.sources();
    reads.fail(0, new Error("database unreachable"));
    await expect(first).rejects.toThrow("database unreachable");
    const second = index.sources();
    expect(reads.started).toBe(2);
    reads.answer(1, [source("recovered")]);
    expect(await second).toEqual([source("recovered")]);
  });
});
