import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient } from "@tanstack/react-query";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  appSetupQueryOptions,
  appsQueryOptions,
  catalogueQueryOptions,
} from "@/lib/apps/queries";
import { companySignInQueryOptions } from "@/lib/auth/company-sign-in";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { botAttentionQueryOptions } from "@/lib/bot-lifecycle/queries";
import { browserStateQueryOptions } from "@/lib/browser/queries";
import {
  channelListQueryOptions,
  channelQueryOptions,
} from "@/lib/channels/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import {
  appsSettingQueryOptions,
  computerModeQueryOptions,
} from "@/lib/enterprise/queries";
import { managementQueryOptions } from "@/lib/management/queries";
import {
  identityProvidersQueryOptions,
  linkedAccountsQueryOptions,
} from "@/lib/identity/queries";
import { memoriesQueryOptions, memorySourcesQueryOptions } from "@/lib/memory";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { organizationHasOthersQueryOptions } from "@/lib/organizations/queries";
import { connectionsQueryOptions } from "@/lib/plugins/queries";
import { proactiveSettingsQueryOptions } from "@/lib/proactive";
import { responsibilitiesQueryOptions } from "@/lib/responsibilities";
import { routinesQueryOptions } from "@/lib/routines/queries";
import { instructionsQueryOptions } from "@/lib/settings/queries";
import { skillListQueryOptions } from "@/lib/skills/queries";
import { teamListPagesQueryOptions } from "@/lib/teams/queries";
import { Route as BotsRoute } from "@/routes/_authed/_app/bots.index";
import { Route as ChannelRoute } from "@/routes/_authed/_app/channel/$channelId";
import { Route as AppsRoute } from "@/routes/_authed/_app/connections.index";
import { Route as GroupRoute } from "@/routes/_authed/_app/group/$channelId";
import { Route as HomeRoute } from "@/routes/_authed/_app/index";
import { Route as MemoryRoute } from "@/routes/_authed/_app/memory";
import { Route as RoutinesRoute } from "@/routes/_authed/_app/routines";
import { Route as SkillsRoute } from "@/routes/_authed/_app/skills";
import { Route as TeamsRoute } from "@/routes/_authed/_app/teams";
import { Route as AdminRoute } from "@/routes/_authed/admin/index";
import { Route as SettingsRoute } from "@/routes/_authed/settings/index";
import { settleReactWork } from "./settle-react-work";

/**
 * A page's loader asks for what the page draws above the fold, so the page opens with its content already in the
 * cache. Every path answers a small fixture; what is asserted is which queries the loader started, by key. Settings and
 * Admin are here because each sends more than one query of its own on entry. What the sign-in gate has already read
 * (the signed-in person, the deployment's capabilities) is seeded where the page depends on it, as the gate leaves it.
 */

const NativeResponse = globalThis.Response;
let queryClient: QueryClient;
let originalFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1/" });
});
beforeEach(() => {
  originalFetch = globalThis.fetch;
  setCurrentOrganization("default");
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const path = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://127.0.0.1",
      ).pathname;
      if (path.endsWith("/conversations/gone"))
        return NativeResponse.json(
          { status: 404, code: "NOT_FOUND", detail: "Not found." },
          {
            status: 404,
            headers: { "content-type": "application/problem+json" },
          },
        );
      return NativeResponse.json({});
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  queryClient.clear();
  await settleReactWork();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/** Runs a route's loader the way a visit does, and returns the cache's keys in a stable order. */
async function keysAfterLoading(
  route: { options: { loader?: unknown } },
  params: Record<string, string> = {},
) {
  const loader = route.options.loader as (options: never) => Promise<unknown>;
  await loader({ context: { queryClient }, params, preload: false } as never);
  return queryClient
    .getQueryCache()
    .getAll()
    .map((query) => JSON.stringify(query.queryKey))
    .sort();
}

/** What the sign-in gate leaves in the cache: the edition the deployment runs as. */
function seedEdition(edition: "team" | "personal") {
  queryClient.setQueryData(deploymentCapabilitiesQueryOptions().queryKey, {
    edition,
  } as never);
}

function keysOf(...factories: { queryKey: readonly unknown[] }[]) {
  return factories.map((factory) => JSON.stringify(factory.queryKey)).sort();
}

test("home loads the conversation list, the Bots and the capabilities", async () => {
  expect(await keysAfterLoading(HomeRoute)).toEqual(
    keysOf(
      channelListQueryOptions(),
      agentListQueryOptions(),
      deploymentCapabilitiesQueryOptions(),
    ),
  );
});

test("a conversation loads only itself", async () => {
  expect(await keysAfterLoading(ChannelRoute, { channelId: "c1" })).toEqual(
    keysOf(channelQueryOptions("c1")),
  );
});

test("a conversation that is gone still opens its page", async () => {
  expect(await keysAfterLoading(ChannelRoute, { channelId: "gone" })).toEqual(
    keysOf(channelQueryOptions("gone")),
  );
  const error = queryClient.getQueryState(channelQueryOptions("gone").queryKey)
    ?.error as { status?: number } | null | undefined;
  expect(error?.status).toBe(404);
});

/** A group's name is in the header, but its transcript is the page's own business, so a hover never pulls it. */
test("a group loads only its own record", async () => {
  expect(await keysAfterLoading(GroupRoute, { channelId: "g1" })).toEqual(
    keysOf(channelQueryOptions("g1")),
  );
});

test("Bots loads the roster, what needs attention and whether anyone else is in the organization", async () => {
  seedEdition("team");
  expect(await keysAfterLoading(BotsRoute)).toEqual(
    keysOf(
      deploymentCapabilitiesQueryOptions(),
      agentListQueryOptions(),
      agentListQueryOptions(true),
      botAttentionQueryOptions(),
      organizationHasOthersQueryOptions("default"),
    ),
  );
});

/** The page asks who else is in the organization only in the team edition. */
test("Bots in the personal edition does not ask who else is in the organization", async () => {
  seedEdition("personal");
  expect(await keysAfterLoading(BotsRoute)).toEqual(
    keysOf(
      deploymentCapabilitiesQueryOptions(),
      agentListQueryOptions(),
      agentListQueryOptions(true),
      botAttentionQueryOptions(),
    ),
  );
});

test("Routines loads the routines, goals, check-ins and Bots", async () => {
  expect(await keysAfterLoading(RoutinesRoute)).toEqual(
    keysOf(
      routinesQueryOptions(),
      responsibilitiesQueryOptions(),
      proactiveSettingsQueryOptions(),
      agentListQueryOptions(),
      agentListQueryOptions(true),
    ),
  );
});

test("Memory loads the memories, the Bots and the sources", async () => {
  expect(await keysAfterLoading(MemoryRoute)).toEqual(
    keysOf(
      memoriesQueryOptions(),
      agentListQueryOptions(),
      memorySourcesQueryOptions(),
    ),
  );
});

test("Skills loads the skills, the person, the Bots and the browser", async () => {
  expect(await keysAfterLoading(SkillsRoute)).toEqual(
    keysOf(
      skillListQueryOptions(),
      currentUserQueryOptions(),
      agentListQueryOptions(),
      agentListQueryOptions(true),
      browserStateQueryOptions(),
    ),
  );
});

/** Not the directory search, which waits for typing, nor the person's own app requests, which are below the list. */
test("Apps loads the apps the first list is drawn from, and in a team whether apps are open", async () => {
  seedEdition("team");
  expect(await keysAfterLoading(AppsRoute)).toEqual(
    keysOf(
      appsQueryOptions(),
      catalogueQueryOptions(),
      appSetupQueryOptions(),
      connectionsQueryOptions(),
      deploymentCapabilitiesQueryOptions(),
      linkedAccountsQueryOptions(),
      identityProvidersQueryOptions(),
      appsSettingQueryOptions(),
    ),
  );
});

/** The personal edition is always open, so it never reads the organization's switch. */
test("Apps in the personal edition does not read whether apps are open", async () => {
  seedEdition("personal");
  expect(await keysAfterLoading(AppsRoute)).toEqual(
    keysOf(
      appsQueryOptions(),
      catalogueQueryOptions(),
      appSetupQueryOptions(),
      connectionsQueryOptions(),
      deploymentCapabilitiesQueryOptions(),
      linkedAccountsQueryOptions(),
      identityProvidersQueryOptions(),
    ),
  );
});

test("Teams loads the first page of the list", async () => {
  seedEdition("team");
  expect(await keysAfterLoading(TeamsRoute)).toEqual(
    keysOf(deploymentCapabilitiesQueryOptions(), teamListPagesQueryOptions("")),
  );
});

/** That edition has no teams API, and its page never asks for the list. */
test("Teams in the personal edition asks for no list", async () => {
  seedEdition("personal");
  expect(await keysAfterLoading(TeamsRoute)).toEqual(
    keysOf(deploymentCapabilitiesQueryOptions()),
  );
});

/** The gate has read the person and the capabilities by now, so only the page's own two reads are new. */
test("Settings loads the standing instructions and the company sign-in", async () => {
  queryClient.setQueryData(currentUserQueryOptions().queryKey, {
    role: "member",
  } as never);
  queryClient.setQueryData(deploymentCapabilitiesQueryOptions().queryKey, {
    edition: "team",
  } as never);
  expect(await keysAfterLoading(SettingsRoute)).toEqual(
    keysOf(
      currentUserQueryOptions(),
      deploymentCapabilitiesQueryOptions(),
      instructionsQueryOptions(),
      companySignInQueryOptions(),
    ),
  );
});

/** For an admin of a team deployment, which is the only one the notice and managed updates ask anything of. */
test("Admin loads managed updates and the computer mode", async () => {
  queryClient.setQueryData(currentUserQueryOptions().queryKey, {
    role: "admin",
  } as never);
  queryClient.setQueryData(deploymentCapabilitiesQueryOptions().queryKey, {
    edition: "team",
  } as never);
  expect(await keysAfterLoading(AdminRoute)).toEqual(
    keysOf(
      currentUserQueryOptions(),
      deploymentCapabilitiesQueryOptions(),
      managementQueryOptions(),
      computerModeQueryOptions(),
    ),
  );
});

/** The personal edition keeps no organization settings, so neither read is asked for. */
test("Admin in the personal edition asks for neither managed updates nor the computer mode", async () => {
  queryClient.setQueryData(currentUserQueryOptions().queryKey, {
    role: "admin",
  } as never);
  queryClient.setQueryData(deploymentCapabilitiesQueryOptions().queryKey, {
    edition: "personal",
  } as never);
  expect(await keysAfterLoading(AdminRoute)).toEqual(
    keysOf(currentUserQueryOptions(), deploymentCapabilitiesQueryOptions()),
  );
});

/** Managed updates do not apply where people sign in through OpenBot by CopilotKit; the computer mode still does. */
test("Admin under hosted sign-in leaves managed updates out", async () => {
  queryClient.setQueryData(currentUserQueryOptions().queryKey, {
    role: "admin",
  } as never);
  queryClient.setQueryData(deploymentCapabilitiesQueryOptions().queryKey, {
    edition: "team",
    hostedSignIn: true,
  } as never);
  expect(await keysAfterLoading(AdminRoute)).toEqual(
    keysOf(
      currentUserQueryOptions(),
      deploymentCapabilitiesQueryOptions(),
      computerModeQueryOptions(),
    ),
  );
});

/** No organization has a company sign-in of its own under hosted sign-in. */
test("Settings under hosted sign-in asks for no company sign-in", async () => {
  queryClient.setQueryData(currentUserQueryOptions().queryKey, {
    role: "member",
  } as never);
  queryClient.setQueryData(deploymentCapabilitiesQueryOptions().queryKey, {
    edition: "team",
    hostedSignIn: true,
  } as never);
  expect(await keysAfterLoading(SettingsRoute)).toEqual(
    keysOf(
      currentUserQueryOptions(),
      deploymentCapabilitiesQueryOptions(),
      instructionsQueryOptions(),
    ),
  );
});

/**
 * With the connection lost the capabilities read is retried without end, and a loader that waited for it
 * would never let the page draw.
 */
describe("a capabilities read that never answers", () => {
  beforeEach(() => {
    globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), {
      preconnect: originalFetch.preconnect,
    }) as typeof fetch;
  });

  test("Settings hands over within the first-screen wait", async () => {
    const started = Date.now();
    await keysAfterLoading(SettingsRoute);
    expect(Date.now() - started).toBeLessThan(450);
  });

  test("Admin hands over within the first-screen wait, though neither deciding read answers", async () => {
    const started = Date.now();
    await keysAfterLoading(AdminRoute);
    expect(Date.now() - started).toBeLessThan(450);
  });
});
