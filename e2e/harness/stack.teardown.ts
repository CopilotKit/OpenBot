import { test as teardown } from "@playwright/test";
import { stopStack } from "./stack";

/**
 * Stop the run's stack once every journey is done. `E2E_KEEP_STACK=1` leaves it up, at
 * http://127.0.0.1:46010, for looking around after a failure; the next run replaces it either way.
 */
teardown("stop the stack", async () => {
  teardown.skip(process.env.E2E_KEEP_STACK === "1", "E2E_KEEP_STACK=1");
  teardown.setTimeout(5 * 60_000);
  await stopStack({ volumes: false });
});
