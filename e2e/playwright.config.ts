import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { aimockServer } from "./harness/aimock";
import { composioStubServer } from "./harness/composio";
import { APP_URL, ARTIFACTS } from "./harness/config";

/**
 * OpenBot end to end: the real product in a real browser, against a real local stack, with every
 * model call answered by aimock. See e2e/README.md.
 *
 * Projects run in this order, through `dependencies` (Playwright's recommended setup pattern):
 *
 *   stack      brings up a fresh, isolated stack with scripts/start.sh (and tears it down after)
 *   first-run  the core loop: a new person's first visit, onboarding, a first answer
 *   journeys   everything else, on a stack a person has already set up
 *
 * One worker, because every journey shares the one stack and the one person on it.
 */
export default defineConfig({
  testDir: ".",
  outputDir: join(ARTIFACTS, "test-results"),
  fullyParallel: false,
  workers: 1,
  // A flaky retry would hide exactly what replay exists to show. A failure is a failure.
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: join(ARTIFACTS, "report"), open: "never" }],
  ],
  use: {
    baseURL: APP_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    viewport: { width: 1440, height: 900 },
  },
  // aimock and the Composio stub start before any project, so the server's first model call and its
  // Composio client both land on them from boot.
  webServer: [aimockServer(), composioStubServer()],
  projects: [
    {
      name: "stack",
      testMatch: /harness\/stack\.setup\.ts/,
      teardown: "stack-teardown",
    },
    {
      name: "stack-teardown",
      testMatch: /harness\/stack\.teardown\.ts/,
    },
    {
      name: "first-run",
      testMatch: /journeys\/core-loop\.journey\.ts/,
      dependencies: ["stack"],
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "journeys",
      testMatch: /journeys\/.*\.journey\.ts/,
      testIgnore: /journeys\/core-loop\.journey\.ts/,
      dependencies: ["first-run"],
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
