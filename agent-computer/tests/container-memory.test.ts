import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  memoryAtOrAbove,
  memoryRunsHigh,
  memoryTargetPercent,
  readContainerMemory,
} from "../src/container-memory";

/**
 * How much of its memory a computer is using, from the files a real container wrote.
 *
 * Every fixture under `fixtures/cgroup` is laid out the way a container sees `/sys/fs/cgroup`, and
 * read here with the same reader the computer uses, only rooted elsewhere. The cgroup v2 ones were
 * captured from throwaway containers (ubuntu:24.04 on Docker 29.5.2, cgroup v2):
 *
 *   v2-limit-512m      docker run --rm --memory 512m, at rest
 *   v2-no-limit        docker run --rm with no --memory, so `memory.max` reads `max`
 *   v2-page-cache      --memory 256m after writing 96 MB to a file, which sits in the page cache
 *   v2-shm-near-limit  --memory 256m --shm-size 256m after writing 224 MB to /dev/shm, which is
 *                      where Chromium keeps the memory its processes share
 *
 * `v1-no-limit/memory/memory.stat` is a cgroup v1 file captured from a container with no limit, as
 * Apache Druid keeps it for its own tests (processing/src/test/resources/memory.stat); this machine's
 * kernel runs cgroup v2, which cannot mount the v1 memory controller. Its `memory.limit_in_bytes` is
 * the `hierarchical_memory_limit` that same file reports, and its `memory.usage_in_bytes` is the
 * file's `cache` plus `rss`, which is what v1 usage is made of.
 */

const FIXTURES = join(import.meta.dir, "fixtures", "cgroup");

/** The memory of the VM the v2 fixtures were captured in: `MemTotal` from its /proc/meminfo. */
const VM_BYTES = 16_353_252 * 1024;

const read = (fixture: string) =>
  readContainerMemory({
    root: join(FIXTURES, fixture),
    machineBytes: VM_BYTES,
  });

describe("reading a container's memory as Kubernetes reads it", () => {
  test("a container with a limit is judged against that limit", async () => {
    // `memory.current` less `inactive_file`, exactly as cAdvisor computes the working set.
    expect(await read("v2-limit-512m")).toEqual({
      workingSet: 1_228_800 - 16_384,
      limit: 512 * 1024 * 1024,
    });
  });

  test("a container with no limit is judged against the machine, which is what runs out", async () => {
    // `memory.max` reads `max`. Inside a container the machine is the VM, and its memory is the
    // limit the OOM killer actually enforces.
    expect(await read("v2-no-limit")).toEqual({
      workingSet: 1_568_768,
      limit: VM_BYTES,
    });
  });

  test("a file in the page cache is not memory the container is short of", async () => {
    /*
     * The case that makes it the working set rather than usage. After writing a 96 MB file, usage
     * reads 39% of a 256 MB limit, and nearly all of it is inactive file cache the kernel drops the
     * moment anything needs the room. Judged on usage, a Bot saving a large download would close
     * other Bots' browsers for memory nobody was short of.
     */
    const reading = await read("v2-page-cache");
    expect(reading).toEqual({
      workingSet: 105_312_256 - 100_982_784,
      limit: 256 * 1024 * 1024,
    });
    if (!reading) throw new Error("no reading");
    expect(105_312_256 / reading.limit).toBeGreaterThan(0.39);
    expect(memoryRunsHigh(reading, 30)).toBe(false);
  });

  test("memory held in /dev/shm counts, and near the limit it reads as high", async () => {
    // Shared memory cannot be dropped like a cache, and Chromium's processes share rendered frames
    // through it. 224 MB of it is 88% of a 256 MB limit.
    const reading = await read("v2-shm-near-limit");
    expect(reading).toEqual({
      workingSet: 236_740_608,
      limit: 256 * 1024 * 1024,
    });
    if (!reading) throw new Error("no reading");
    expect(memoryRunsHigh(reading, 85)).toBe(true);
    expect(memoryRunsHigh(reading, 90)).toBe(false);
  });

  test("cgroup v1, with no limit, is read from its own files and judged against the machine", async () => {
    // v1 writes no limit as a number near 2^63 rather than `max`, and its inactive cache is
    // `total_inactive_file`, which includes the cgroups beneath it.
    expect(await read("v1-no-limit")).toEqual({
      workingSet: 9_711_616 - 2_019_328,
      limit: VM_BYTES,
    });
  });

  test("a computer with no cgroup of its own reads nothing, and so closes nothing for memory", async () => {
    // OpenBot Desktop's computer on a Mac, or one started by hand on a Linux desktop, whose view of
    // /sys/fs/cgroup is the root, where none of these files exist.
    const empty = await mkdtemp(join(tmpdir(), "openbot-no-cgroup-"));
    try {
      expect(
        await readContainerMemory({ root: empty, machineBytes: VM_BYTES }),
      ).toBeUndefined();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe("whether memory runs high", () => {
  const LIMIT = 1_000;

  test("at the share it acts, and a byte under it does not", () => {
    // At or above, so a deployment that said 85 has acted by the time it reads 85.
    expect(memoryRunsHigh({ workingSet: 850, limit: LIMIT }, 85)).toBe(true);
    expect(memoryRunsHigh({ workingSet: 849, limit: LIMIT }, 85)).toBe(false);
  });

  test("a share of zero switches it off", () => {
    expect(memoryRunsHigh({ workingSet: LIMIT, limit: LIMIT }, 0)).toBe(false);
  });
});

describe("where closing for memory stops", () => {
  const LIMIT = 1_000;

  test("ten points under where it starts, so 75 at the default 85", () => {
    expect(memoryTargetPercent(85)).toBe(75);
    expect(memoryTargetPercent(60)).toBe(50);
  });

  test("between the two lines nothing starts, and a pass that started goes on", () => {
    // 80% does not start a pass at 85, and a pass already closing at 85 does not stop at 80: it
    // closes on to under 75, so the next launch does not cross 85 again straight away.
    const at80 = { workingSet: 800, limit: LIMIT };
    expect(memoryRunsHigh(at80, 85)).toBe(false);
    expect(memoryAtOrAbove(at80, memoryTargetPercent(85))).toBe(true);
    expect(
      memoryAtOrAbove(
        { workingSet: 749, limit: LIMIT },
        memoryTargetPercent(85),
      ),
    ).toBe(false);
  });
});
