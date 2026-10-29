/**
 * How much of its memory this computer is using, read the way Kubernetes reads it.
 *
 * WHY THIS EXISTS. A computer runs one Chromium per Bot that is browsing, and the only limits on them
 * were a count and an idle timeout. Neither looks at memory, so a few heavy pages could push the
 * container past its limit, and the kernel's OOM killer does not choose by use. On Kubernetes with
 * cgroup v2 the kubelet sets `memory.oom.group` (since 1.28), so one OOM kills every process in the
 * container and every Bot's browser on it goes at once; elsewhere the kernel kills the largest
 * process, which is somebody's browser picked by size. Knowing how close the container is lets the
 * computer close the least recently used browser first, which costs that Bot a relaunch and nothing
 * else, because its profile is on disk.
 *
 * WORKING SET, NOT USAGE. The cgroup's usage counts the page cache, and most of a page cache is files
 * the kernel will drop the moment anything needs the room: a container that wrote a large download
 * reads as nearly full while it is nowhere near being killed. Kubernetes judges a container by its
 * working set, which is usage less the inactive file cache, and that is what this reads, so the
 * computer measures itself the way the kubelet measures it. cAdvisor computes it in
 * `lib/container/libcontainer/handler.go`: `memory.current` less `inactive_file` on cgroup v2, and
 * `memory.usage_in_bytes` less `total_inactive_file` on cgroup v1, clamped at zero. Microsoft's AKS
 * guide to high memory consumption and the widely cited "Memory_working_set vs Memory_rss in
 * Kubernetes" describe the same rule.
 *
 * THE LIMIT IS WHICHEVER RUNS OUT FIRST. A container started with no limit (`docker run` with no
 * `--memory`, Docker Desktop's default) reports `max` on cgroup v2 and a number near 2^63 on cgroup
 * v1. Inside a container, the machine's own memory is the VM's, and that is what actually runs out,
 * so the limit is the smaller of the cgroup's and the machine's.
 *
 * NO CGROUP, NO READING. A computer that is not in a container (the one OpenBot Desktop runs on a
 * person's Mac for their own browser, or one started by hand on a Linux desktop, whose view of
 * `/sys/fs/cgroup` is the root, where these files do not exist) has nothing here to read, and closes
 * nothing for memory. The count cap is still there.
 *
 * Its own file, with no Playwright import, for the reason `browser-eviction.ts` is: the parsing is
 * the part with a wrong answer available, and the tests feed it the files real containers wrote.
 */

import { readFile } from "node:fs/promises";
import { totalmem } from "node:os";
import { join } from "node:path";

/** How much memory the computer is using, and how much it may. Both in bytes. */
export type MemoryReading = { workingSet: number; limit: number };

/** Read one cgroup file, or nothing when it is not there. Injected so a test can point it elsewhere. */
export type ReadCgroupFile = (path: string) => Promise<string | undefined>;

/** Where a container sees its own cgroup, under cgroup v2 and the v1 memory controller. */
export const CGROUP_ROOT = "/sys/fs/cgroup";

const readCgroupFile: ReadCgroupFile = (path) =>
  readFile(path, "utf8").catch(() => undefined);

/** A whole number of bytes, as a cgroup file writes one. Anything else is not a reading. */
function bytes(text: string | undefined): number | undefined {
  const trimmed = text?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

/** One counter from a `memory.stat` file, whose lines are `<name> <value>`. */
export function statValue(stat: string, name: string): number | undefined {
  for (const line of stat.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (key === name) return bytes(value);
  }
  return undefined;
}

/**
 * Usage less the inactive file cache, clamped at zero, as cAdvisor does it. A `memory.stat` without
 * the counter leaves usage as it is, also as cAdvisor does.
 */
function workingSetOf(
  usage: number,
  stat: string | undefined,
  inactiveFile: string,
): number {
  const inactive =
    stat === undefined ? undefined : statValue(stat, inactiveFile);
  if (inactive === undefined) return usage;
  return usage < inactive ? 0 : usage - inactive;
}

/**
 * The limit that runs out first: the cgroup's, or the machine's when the cgroup has none or claims
 * more than the machine has. Cgroup v2 writes `max` for none; v1 writes a number near 2^63, which
 * the machine is always smaller than.
 */
function limitOf(
  cgroupLimit: string | undefined,
  machineBytes: number,
): number | undefined {
  if (cgroupLimit?.trim() === "max") return machineBytes;
  const limit = bytes(cgroupLimit);
  if (limit === undefined || limit === 0) return undefined;
  return Math.min(limit, machineBytes);
}

/**
 * The computer's memory from cgroup v2's `memory.current`, `memory.max` and `memory.stat`.
 *
 * Undefined when the usage or the limit cannot be read, which is a computer with no cgroup of its
 * own and so nothing to act on.
 */
export function cgroupV2Memory(
  files: { current?: string; max?: string; stat?: string },
  machineBytes: number,
): MemoryReading | undefined {
  const usage = bytes(files.current);
  const limit = limitOf(files.max, machineBytes);
  if (usage === undefined || limit === undefined) return undefined;
  return {
    workingSet: workingSetOf(usage, files.stat, "inactive_file"),
    limit,
  };
}

/**
 * The computer's memory from cgroup v1's `memory.usage_in_bytes`, `memory.limit_in_bytes` and
 * `memory.stat`, for a host that still mounts the v1 memory controller.
 */
export function cgroupV1Memory(
  files: { usage?: string; limit?: string; stat?: string },
  machineBytes: number,
): MemoryReading | undefined {
  const usage = bytes(files.usage);
  const limit = limitOf(files.limit, machineBytes);
  if (usage === undefined || limit === undefined) return undefined;
  return {
    workingSet: workingSetOf(usage, files.stat, "total_inactive_file"),
    limit,
  };
}

/**
 * Read the computer's memory now: cgroup v2 first, then v1, then nothing.
 *
 * Read again every time it is asked rather than cached, because the caller asks precisely when it
 * has just closed a browser and wants to know whether that was enough.
 */
export async function readContainerMemory({
  root = CGROUP_ROOT,
  read = readCgroupFile,
  machineBytes = totalmem(),
}: {
  root?: string;
  read?: ReadCgroupFile;
  machineBytes?: number;
} = {}): Promise<MemoryReading | undefined> {
  const [current, max, stat] = await Promise.all([
    read(join(root, "memory.current")),
    read(join(root, "memory.max")),
    read(join(root, "memory.stat")),
  ]);
  if (current !== undefined)
    return cgroupV2Memory({ current, max, stat }, machineBytes);
  const v1 = join(root, "memory");
  const [usage, limit, v1Stat] = await Promise.all([
    read(join(v1, "memory.usage_in_bytes")),
    read(join(v1, "memory.limit_in_bytes")),
    read(join(v1, "memory.stat")),
  ]);
  if (usage === undefined) return undefined;
  return cgroupV1Memory({ usage, limit, stat: v1Stat }, machineBytes);
}

/** Whether the working set is at or above a share of the limit. */
export function memoryAtOrAbove(
  reading: MemoryReading,
  percent: number,
): boolean {
  return reading.workingSet * 100 >= reading.limit * percent;
}

/**
 * Whether the computer is close enough to its limit to start closing browsers.
 *
 * At or above the share, not only above it, so a deployment that set 85 has acted by the time it
 * reads 85. A share of zero or less switches it off, as a timeout of zero switches off the idle
 * sweep.
 */
export function memoryRunsHigh(
  reading: MemoryReading,
  highPercent: number,
): boolean {
  if (highPercent <= 0) return false;
  return memoryAtOrAbove(reading, highPercent);
}

/**
 * How far under the share that starts the closing memory has to fall before the closing stops.
 *
 * Stopping at the same line it started at leaves the computer a browser's launch from crossing it
 * again, so the next Bot to start closes another browser, whose Bot starts again and closes another:
 * each launch paying for the last. Closing on to ten points under gives the launches after it room.
 * Ten points, not a setting of its own: it is a gap between two numbers, and the one an operator
 * chooses is where the closing starts.
 */
export const MEMORY_TARGET_POINTS_UNDER = 10;

/**
 * The share closing stops under: {@link MEMORY_TARGET_POINTS_UNDER} below where it starts, so 75 at
 * the default 85. At or under zero, which only a starting share of ten or less gives, closing goes on
 * while anything is left that may be closed.
 */
export function memoryTargetPercent(highPercent: number): number {
  return highPercent - MEMORY_TARGET_POINTS_UNDER;
}
