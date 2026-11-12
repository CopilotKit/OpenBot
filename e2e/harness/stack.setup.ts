import { test as setup } from "@playwright/test";
import { startStack } from "./stack";

/** A fresh, isolated OpenBot stack for this run. See stack.ts. */
setup("bring up a fresh stack with scripts/start.sh", async () => {
  // The first run on a machine builds the server and computer images.
  setup.setTimeout(25 * 60_000);
  await startStack();
});
