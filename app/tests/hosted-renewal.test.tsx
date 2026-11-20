import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RenewalNotices } from "@/components/auth/renewal-notices";
import { Toaster } from "@/components/ui/toast";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  RENEWED_MARKER,
  renewalAddress,
  renewalDeps,
} from "@/lib/auth/renewal";
import { ClientError } from "@/lib/client";
import {
  currentOrganizationId,
  setCurrentOrganization,
} from "@/lib/organizations/current";
import { renameOrganizationMutationOptions } from "@/lib/organizations/mutations";
import { settleReactWork } from "./settle-react-work";

/**
 * A hosted OpenBot's admin action whose proof from OpenBot by CopilotKit ran out: OpenBot refuses
 * it with 401 `HOSTED_SIGN_IN_RENEWAL_REQUIRED` and names where sign-in renews it
 * (`OpenBot-Sign-In`). The app sends the page through that sign-in and back, with a marker, with
 * nothing to click; a refusal again moments later offers "Sign in again" instead of a loop; and
 * none of it is ever taken for being signed out.
 *
 * Driven through the app's own transport and mutations, with the server's answers as the API
 * writes them, and the browser's navigation and storage stood in for.
 */

const PAGE = "http://openbot.test/settings/organization?tab=members";
const RENEWAL = {
  type: "https://open.bot/errors/hosted-sign-in-renewal-required",
  title: "Your sign-in needs renewing.",
  status: 401,
  detail: "Your sign-in needs renewing.",
  code: "HOSTED_SIGN_IN_RENEWAL_REQUIRED",
  category: "auth",
  retryable: true,
  requestId: "req_example",
  traceId: "trace_example",
};

const originalFetch = globalThis.fetch;
const originalDeps = { ...renewalDeps };
let sentTo: string[];
let kept: Map<string, string>;
let clock: number;
let originalOrganization: string | undefined;

beforeAll(() => {
  GlobalRegistrator.register({ url: PAGE });
  originalOrganization = currentOrganizationId();
});
beforeEach(() => {
  sentTo = [];
  kept = new Map();
  clock = 1_800_000_000_000;
  renewalDeps.navigate = (address) => sentTo.push(address);
  renewalDeps.now = () => clock;
  renewalDeps.storage = () =>
    ({
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => kept.set(key, value),
    }) as unknown as Storage;
  window.history.replaceState(null, "", PAGE);
  setCurrentOrganization("org_acme");
  globalThis.fetch = Object.assign(
    async () =>
      new Response(JSON.stringify(RENEWAL), {
        status: 401,
        headers: {
          "content-type": "application/problem+json",
          "OpenBot-Sign-In": "/api/auth/hosted/sign-in",
        },
      }),
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
});
afterEach(async () => {
  cleanup();
  await settleReactWork();
  globalThis.fetch = originalFetch;
  Object.assign(renewalDeps, originalDeps);
});
afterAll(() => {
  setCurrentOrganization(originalOrganization);
  GlobalRegistrator.unregister();
});

const expected = (page: string) => {
  const back = new URL(page);
  back.searchParams.set(RENEWED_MARKER, "1");
  return `/api/auth/hosted/sign-in?returnTo=${encodeURIComponent(back.href)}`;
};

test("the renewal address is the sign-in OpenBot names, back to this page with the marker, and never another site", () => {
  expect(renewalAddress("/api/auth/hosted/sign-in", PAGE)).toBe(expected(PAGE));
  for (const named of [
    null,
    "https://elsewhere.test/sign-in",
    "//elsewhere.test",
  ])
    expect(renewalAddress(named, PAGE)).toBe(expected(PAGE));
});

test("an admin action refused for renewal goes through the hosted sign-in and back with nothing to click, and a second refusal moments later offers Sign in again", async () => {
  const queryClient = new QueryClient();
  const rename = renameOrganizationMutationOptions(queryClient).mutationFn;
  const refused = await rename?.(
    { organizationId: "org_acme", name: "Acme Labs" },
    undefined as never,
  ).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(ClientError);
  expect(refused).toMatchObject({
    status: 401,
    code: "HOSTED_SIGN_IN_RENEWAL_REQUIRED",
  });
  expect(sentTo).toEqual([expected(PAGE)]);

  // Back already, and refused again a moment later: it can't renew by itself, so the person is asked.
  const view = render(
    <>
      <Toaster />
      <RenewalNotices />
    </>,
  );
  clock += 10_000;
  await act(async () => {
    await rename?.(
      { organizationId: "org_acme", name: "Acme Labs" },
      undefined as never,
    ).catch(() => undefined);
  });
  expect(sentTo).toHaveLength(1);
  // The toast is still sliding in, so the accessibility tree has it hidden for now.
  const again = await view.findByRole("button", {
    name: "Sign in again",
    hidden: true,
  });
  expect(
    view.getAllByText("Your sign-in needs renewing before you can do that.")
      .length,
  ).toBeGreaterThan(0);

  // Clicked: the same address.
  const followed: string[] = [];
  const assign = window.location.assign;
  window.location.assign = ((address: string) =>
    followed.push(address)) as typeof window.location.assign;
  try {
    await userEvent.setup({ document }).click(again);
  } finally {
    window.location.assign = assign;
  }
  expect(followed).toEqual([expected(PAGE)]);

  // Long after, a proof that ran out again renews by itself again.
  clock += 10 * 60_000;
  await rename?.(
    { organizationId: "org_acme", name: "Acme Labs" },
    undefined as never,
  ).catch(() => undefined);
  expect(sentTo).toHaveLength(2);
});

test("a sign-in that needs renewing is never taken for being signed out", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const read = await queryClient.fetchQuery(currentUserQueryOptions()).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  // Signed out reads as null; this is a failure the page goes on renewing from.
  expect(read).not.toEqual({ value: null });
  expect((read as { error: unknown }).error).toMatchObject({
    code: "HOSTED_SIGN_IN_RENEWAL_REQUIRED",
  });
});

test("back from the round trip, the marker comes off the address and the person is told they're signed in again", async () => {
  window.history.replaceState(null, "", `${PAGE}&${RENEWED_MARKER}=1`);
  const view = render(
    <>
      <Toaster />
      <RenewalNotices />
    </>,
  );
  await view.findByText(
    "You're signed in again. If something you just did didn't finish, do it again.",
  );
  await waitFor(() => expect(window.location.href).toBe(PAGE));
});
