// server/tests/support/memory.ts
//
// A person's memory for the tests, in a real Intelligence.
//
// Memories and memory sources live in Intelligence (src/memory/intelligence.ts). A test reads and writes them
// there, through the same client, cache and store the server uses: a fake that passed while the real one
// refused would be exactly the test that lies.
//
// WHICH INTELLIGENCE. `TEST_INTELLIGENCE_API_URL`, `TEST_INTELLIGENCE_API_KEY` and
// `TEST_INTELLIGENCE_GATEWAY_WS_URL` name it (support/bots.ts): missing, every test that touches memory
// fails here and says so.
import type { Database } from "../../src/db/client";
import { createProjectChangesClient } from "../../src/intelligence/project-changes";
import { createMemoryCache, type MemoryCache } from "../../src/memory/cache";
import {
  createIntelligenceMemory,
  type IntelligenceMemory,
} from "../../src/memory/intelligence";
import { createMemoryStore, type MemoryStore } from "../../src/memory/store";
import { testIntelligence } from "./bots";

let client: IntelligenceMemory | undefined;

/** The memory client for the test Intelligence. Throws, loudly, when it is not set. */
export function testMemoryIntelligence(): IntelligenceMemory {
  if (client) return client;
  const intelligence = testIntelligence();
  client = createIntelligenceMemory({
    apiUrl: intelligence.apiUrl,
    apiKey: intelligence.apiKey,
  });
  return client;
}

export type TestMemory = {
  store: MemoryStore;
  cache: MemoryCache;
  intelligence: IntelligenceMemory;
};

/**
 * One server instance's memory: its own cache, the store over it. With `changes`, the cache follows
 * `memory_changes` from the test Intelligence's gateway, as a server does; stop it when done.
 */
export function testMemory(
  database: Database,
  options: { changes?: boolean; now?: () => number } = {},
): TestMemory {
  const intelligence = testMemoryIntelligence();
  const settings = testIntelligence();
  const cache = createMemoryCache({
    intelligence,
    ...(options.changes
      ? {
          changes: {
            client: createProjectChangesClient({
              apiUrl: settings.apiUrl,
              apiKey: settings.apiKey,
            }),
            gatewayWsUrl: settings.gatewayWsUrl,
          },
        }
      : {}),
  });
  if (options.changes) cache.start();
  const store = createMemoryStore(database, {
    intelligence,
    cache,
    ...(options.now ? { now: options.now } : {}),
  });
  return { store, cache, intelligence };
}

/** Removes everything these people have in Intelligence's memory. */
export async function removeTestMemory(
  people: readonly string[],
): Promise<void> {
  const intelligence = testMemoryIntelligence();
  for (const userId of people) {
    await intelligence.purgeSources({ userId });
    await intelligence.purgePerson(userId);
  }
}

/** Polls until `check` holds, or fails naming `what`. */
export async function eventually(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}
