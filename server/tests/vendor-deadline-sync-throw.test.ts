// server/tests/vendor-deadline-sync-throw.test.ts
/**
 * A vendor call that throws BEFORE it returns a promise still has its deadline cleared.
 *
 * `withVendorDeadline` arms a ten-second timer and then races it against the call. Built inline as
 * `Promise.race([call(signal), deadline])`, a call that throws SYNCHRONOUSLY threw out of the
 * helper before the race existed: no `.finally` was ever attached, so the timer stayed armed, and
 * ten seconds after the person had been answered it aborted nothing anybody was waiting on and
 * rejected a promise nobody held, an unhandled rejection in a deployment that had already replied.
 *
 * ONCE REACHED THROUGH A ROUTE, NOW ASSERTED ON THE HELPER. The Composio connect route used to
 * build its return address inside the deadline's callback, and `brokerReturnUrl` throws
 * synchronously on an `OPENBOT_APP_URL` with its scheme left off (`app.example` rather than
 * `https://app.example`). Connect now checks that address before anything is asked of the broker,
 * so the route no longer arms a deadline for it at all, which the second test pins. The helper's
 * own promise still matters for the next call that throws while it is built, so the first test
 * drives the helper with exactly that.
 *
 * HOW THE TIMER IS WATCHED. Only timers armed for the deadline's own bound are captured, and they
 * are captured WITHOUT being scheduled, so this file does not wait ten seconds to see one fire. Any
 * capture that was not cleared is then fired by hand, which is exactly what the event loop would
 * have done, and the rejection it produces is caught by an `unhandledRejection` listener rather
 * than taking the test runner with it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { AccountModeSwitch } from "../src/plugins/account-mode";
import type { ComposioBroker } from "../src/plugins/broker";
import { createPluginRoutes } from "../src/plugins/routes";
import type { SharedUseStore } from "../src/plugins/shared-use-store";
import type { PluginStore } from "../src/plugins/store";
import { withVendorDeadline } from "../src/plugins/vendor-deadline";

/** `VENDOR_CALL_TIMEOUT_MS` in `vendor-deadline.ts`. Not exported, and a timer of any other length is not this one. */
const VENDOR_CALL_TIMEOUT_MS = 10_000;
const SERVER_ID = "brokered-gmail";

type Captured = { fire: () => void; cleared: boolean };

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let captured: Captured[] = [];
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  captured = [];
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
  globalThis.setTimeout = ((
    handler: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (ms !== VENDOR_CALL_TIMEOUT_MS)
      return realSetTimeout(handler, ms, ...args);
    const entry: Captured = { fire: () => handler(...args), cleared: false };
    captured.push(entry);
    return entry as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: unknown) => {
    const entry = captured.find((candidate) => candidate === handle);
    if (entry) entry.cleared = true;
    else realClearTimeout(handle as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  process.off("unhandledRejection", onUnhandled);
});

/** A Composio deployment whose app URL was configured without its scheme. */
function deployment() {
  const authorized: string[] = [];
  const store = {
    brokerProvider: "composio",
    serverAddress: async (serverId: string) =>
      serverId === SERVER_ID
        ? {
            id: SERVER_ID,
            title: "Gmail",
            url: "composio://gmail",
            authScheme: "OAUTH2",
          }
        : undefined,
    serverUrls: async () => ["composio://gmail"],
    accountRefFor: async (_serverId: string, actorId: string) => ({
      ref: {
        holder: "person" as const,
        userId: actorId,
        vendorUserId: actorId,
      },
      title: "Gmail",
      mode: "personal" as const,
    }),
    brokeredConnection: async () => null,
    listSkills: async () => [],
  } as unknown as PluginStore;

  const broker = {
    grantIsLocal: true,
    authProviderOf: async () => null,
    authorizations: null,
    listApps: async () => [],
    authorize: async (input: { toolkit: string }) => {
      authorized.push(input.toolkit);
      return {
        redirectUrl: "https://vendor.example/consent",
        authorizationId: null,
      };
    },
  } as unknown as ComposioBroker;

  const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: "person-1",
      email: "person@example.test",
      role: "user",
    } as never);
    await next();
  };

  const app = new Hono().route(
    "/api/plugins",
    createPluginRoutes(
      store,
      signedIn,
      async () => true,
      {
        publicUrl: "https://openbot.example",
        // THE MISTAKE: no scheme, so `brokerReturnUrl` throws as the callback's argument is built.
        appUrl: "app.example",
        encryptionKey: `${"A".repeat(43)}=`,
        personHasAccess: async () => true,
      },
      { broker, provider: "composio" },
      {
        modes: {} as unknown as AccountModeSwitch,
        use: {} as unknown as SharedUseStore,
      },
    ),
  );
  return {
    authorized,
    connect: () =>
      app.request(
        `http://openbot.test/api/plugins/servers/${SERVER_ID}/connect`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
  };
}

test("a call that throws while it is built still has its deadline cleared", async () => {
  const thrown = new Error("the call could not be built");
  const answered = await withVendorDeadline(() => {
    throw thrown;
  }).then(
    () => null,
    (error: unknown) => error,
  );

  // The caller's own rejection, not one that escaped before the race existed.
  expect(answered).toBe(thrown);

  // The deadline WAS armed, otherwise the next assertion is about nothing.
  expect(captured.length).toBe(1);
  const leftArmed = captured.filter((entry) => !entry.cleared).length;

  // Fire whatever was not cleared, as the event loop would have ten seconds later.
  for (const entry of captured) if (!entry.cleared) entry.fire();
  await new Promise((resolve) => realSetTimeout(resolve, 0));

  // It was cleared, so nothing is left to fire after the caller has been answered...
  expect(leftArmed).toBe(0);
  // ...and nothing rejects later with nobody holding the promise.
  expect(unhandled).toEqual([]);
});

test("a return address that is not an address is refused before any deadline is armed", async () => {
  const it = deployment();
  const response = await it.connect();

  // The refusal itself is unchanged: answered, not a 500, and the vendor never asked.
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.status).not.toBe(500);
  expect(it.authorized).toEqual([]);

  // Checked before the broker is called, so there was no deadline to arm or to leave armed.
  expect(captured).toEqual([]);
  expect(unhandled).toEqual([]);
});
