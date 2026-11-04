// server/tests/support/policy.ts
//
// Organization policy for the tests, in a real Intelligence.
//
// Capability switches, enterprise settings, network rules, the computer-action boundary, approval
// preferences and rules, and Shared app approvals live in Intelligence's organization policy, so a test
// that needs one sets it there, through the same cache the server uses, and reads it back the way the
// server does. There is no stand-in: a fake that passed while the real one refused would be exactly the
// test that lies.
//
// ONE PROJECT, SHARED BY EVERY FILE. Policy is the project's, and some of it is one record per project
// (the settings, the action boundary), so a file that changes it puts it back: `resetTestPolicy` in a
// `beforeEach`/`afterEach` returns the whole project to the defaults, the way the old tests deleted
// their rows.
//
// WHICH INTELLIGENCE: the one `support/bots.ts` names, through the same three variables, failing by
// name when they are missing.
import { removeBotPolicy } from "../../src/policy/bot-rows";
import {
  createPolicyCache,
  installPolicyCache,
  type PolicyCache,
} from "../../src/policy/cache";
import { createOrgPolicyClient } from "../../src/policy/client";
import { testIntelligence, useTestBots } from "./bots";

let started: Promise<PolicyCache> | undefined;

/**
 * The process's policy cache, against the test Intelligence, installed and loaded. Once per process:
 * every file shares it, as every file shares the test database and the Bot directory.
 */
export function useTestPolicy(): Promise<PolicyCache> {
  started ??= (async () => {
    const cache = installPolicyCache(createTestPolicyCache());
    await cache.start();
    // The same cleanup the server wires: a purged Bot takes its Shared app approvals with it.
    const directory = await useTestBots();
    directory.onPurged(async (botId) => {
      await removeBotPolicy(
        cache,
        [botId],
        async (id) => (await directory.registry.get(id)) === null,
      );
    });
    return cache;
  })();
  return started;
}

/**
 * A policy cache of its own, not installed: what another server holds. Subscribed to Intelligence's
 * announcements like the server's, so a test can watch a change made through one reach the other.
 * The caller starts and stops it.
 */
export function createTestPolicyCache(
  options: { resyncIntervalMs?: number; subscribe?: boolean } = {},
): PolicyCache {
  const intelligence = testIntelligence();
  return createPolicyCache({
    client: createOrgPolicyClient({
      apiUrl: intelligence.apiUrl,
      apiKey: intelligence.apiKey,
    }),
    ...(options.subscribe === false
      ? {}
      : { gatewayWsUrl: intelligence.gatewayWsUrl }),
    ...(options.resyncIntervalMs
      ? { resyncIntervalMs: options.resyncIntervalMs }
      : {}),
  });
}

/**
 * Return the project's whole policy to the defaults: settings and boundary reset, every capability and
 * network rule removed, every approval rule revoked, every person's preferences and every Shared app
 * approval removed. Through the installed cache, so what this process holds agrees at once.
 */
export async function resetTestPolicy(): Promise<void> {
  const cache = await useTestPolicy();
  const client = cache.client;
  if ((await client.settings()).version > 0) await cache.resetSettings();
  if ((await client.actionBoundary()).version > 0)
    await cache.resetActionBoundary();
  for (const rule of (await client.capabilityRules()).items)
    await cache.deleteCapabilityRule(rule);
  for (const rule of (await client.networkRules()).items)
    await cache.deleteNetworkRule(rule);
  for (const rule of (await client.approvalRules()).items)
    await cache.revokeApprovalRule(rule.id);
  for (const preferences of (await client.approvalPreferencesList()).items)
    await client.deleteApprovalPreferences(
      preferences.userId,
      `test-reset:${crypto.randomUUID()}`,
    );
  for (const approval of (await client.connectionApprovals()).items)
    await cache.deleteConnectionApproval(approval);
  await cache.resync();
}

/** Poll until `condition` holds, or fail after `timeoutMs` saying what was waited for. */
export async function until(
  what: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}.`);
}

/** The Shared app approvals Intelligence holds now, past this process's memory. */
export async function storedConnectionApprovals(
  filter: { agentId?: string; connectionId?: string } = {},
) {
  return (await (await useTestPolicy()).client.connectionApprovals(filter))
    .items;
}
