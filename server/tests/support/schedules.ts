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
