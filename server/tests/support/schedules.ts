// server/tests/support/schedules.ts
//
// Routines, check-ins and responsibilities for the tests, in a real Intelligence.
//
// They live in Intelligence's agent schedules now, so a test reads and writes them there through the
// same client and directory the server uses. There is no stand-in: a fake that passed while the real
// one refused would be exactly the test that lies. Which Intelligence: the one `support/bots.ts`
// names (`TEST_INTELLIGENCE_API_URL`, `TEST_INTELLIGENCE_API_KEY`, `TEST_INTELLIGENCE_GATEWAY_WS_URL`);
// missing, every test that touches a schedule fails and says so.
import { createScheduleClient } from "../../src/schedules/client";
import {
  createScheduleDirectory,
  installScheduleDirectory,
  type ScheduleDirectory,
} from "../../src/schedules/directory";
import { testIntelligence } from "./bots";

let started: Promise<ScheduleDirectory> | undefined;

/**
 * The process's schedule directory, against the test Intelligence, installed and loaded. Once per
 * process: every file shares it, as every file shares the test database.
 */
export function useTestSchedules(): Promise<ScheduleDirectory> {
  started ??= (async () => {
    const intelligence = testIntelligence();
    const directory = installScheduleDirectory(
      createScheduleDirectory({
        client: createScheduleClient({
          apiUrl: intelligence.apiUrl,
          apiKey: intelligence.apiKey,
        }),
        gatewayWsUrl: intelligence.gatewayWsUrl,
      }),
    );
    await directory.start();
    return directory;
  })();
  return started;
}

/** A client of its own on the test Intelligence, for a test that must look past this process's memory. */
export function testScheduleClient() {
  const intelligence = testIntelligence();
  return createScheduleClient({
    apiUrl: intelligence.apiUrl,
    apiKey: intelligence.apiKey,
  });
}

/** The routine as Intelligence holds it now. Throws when there is none. */
export async function storedRoutine(id: string) {
  const routine = await (await useTestSchedules()).client.get("routines", id);
  if (!routine) throw new Error(`Intelligence has no routine ${id}`);
  return routine;
}

/**
 * Change a routine directly, at its current version, through the directory so this process sees the
 * change at once. For a test that used to `update` the `routines` row: making one due in the past,
 * or giving it a stamp no person's edit would.
 */
export async function changeRoutine(
  id: string,
  changes: Parameters<ScheduleDirectory["update"]>[3],
) {
  const directory = await useTestSchedules();
  const current = await storedRoutine(id);
  return directory.update("routines", id, current.version, changes);
}

/** One routine run as Intelligence holds it, or undefined. */
export async function storedRun(id: string) {
  return (
    (await (await useTestSchedules()).client.get("routine-runs", id)) ??
    undefined
  );
}

/** Every run of one routine, newest first. */
export async function runsOf(routineId: string) {
  return (
    await (await useTestSchedules()).client.all("routine-runs", { routineId })
  ).items;
}

/** Change a run directly, at its current version. For a test that aged a run row by hand. */
export async function changeRun(
  id: string,
  changes: Parameters<ReturnType<typeof testScheduleClient>["update"]>[3],
) {
  const client = (await useTestSchedules()).client;
  const run = await client.get("routine-runs", id);
  if (!run) throw new Error(`Intelligence has no routine run ${id}`);
  return client.update("routine-runs", id, run.version, changes);
}

/** Remove a person's routines for good, runs included, as test cleanup. */
export async function purgeRoutinesOwnedBy(ownerUserId: string) {
  const directory = await useTestSchedules();
  const { items } = await directory.client.all("routines", {
    ownerUserId,
    includeDeleted: true,
  });
  for (const routine of items) await directory.purge("routines", routine.id);
}

/**
 * Make a routine in Intelligence directly, for a test that used to insert a `routines` row: no
 * channel check, no cap, a clock a day ahead unless it names one.
 */
export async function seedRoutine(input: {
  id?: string;
  ownerUserId: string;
  agentId: string;
  channelId: string;
  instruction?: string;
  cron?: string;
  timezone?: string;
  enabled?: boolean;
  nextRunAt?: Date;
}) {
  const directory = await useTestSchedules();
  const now = new Date();
  return directory.create("routines", {
    id: input.id ?? `routine_${crypto.randomUUID()}`,
    ownerUserId: input.ownerUserId,
    agentId: input.agentId,
    channelId: input.channelId,
    instruction: input.instruction ?? "Post the standup summary.",
    cron: input.cron ?? "0 9 * * *",
    timezone: input.timezone ?? "UTC",
    enabled: input.enabled ?? true,
    enabledAt: now,
    nextRunAt: input.nextRunAt ?? new Date(now.getTime() + 86_400_000),
    lastRunAt: null,
  });
}

/** Open a run of a routine in Intelligence directly, for a test that used to insert a `routine_runs` row. */
export async function seedRun(
  routineId: string,
  id = `routine_run_${crypto.randomUUID()}`,
) {
  return (await useTestSchedules()).client.create("routine-runs", {
    id,
    routineId,
    source: "schedule",
    status: null,
    startedAt: new Date(),
    finishedAt: null,
    waiting: null,
    error: null,
  });
}
