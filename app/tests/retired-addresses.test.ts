import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { deploymentKeys } from "@/lib/deployment/queries";
import { Route as BotAccessRoute } from "@/routes/_authed/_app/bots.$agentId.access";
import { Route as BotResponsibilitiesRoute } from "@/routes/_authed/_app/bots.$agentId.responsibilities";
import { Route as CapabilitiesRoute } from "@/routes/_authed/_app/capabilities.index";
import { Route as CapabilitiesMemoryRoute } from "@/routes/_authed/_app/capabilities.memory";
import { Route as CapabilitiesSkillsRoute } from "@/routes/_authed/_app/capabilities.skills";
import { Route as SkillPageRoute } from "@/routes/_authed/settings/_personal/skills_.$slug";
import { Route as NewSkillRoute } from "@/routes/_authed/settings/_personal/skills_.new";
import { Route as BrowsersRoute } from "@/routes/_authed/settings/browsers";
import { Route as CredentialsRoute } from "@/routes/_authed/settings/credentials";
import { Route as NewCredentialRoute } from "@/routes/_authed/settings/credentials_.new";
import { Route as LearningRoute } from "@/routes/_authed/settings/learning";
import { Route as SettingsMemoryRoute } from "@/routes/_authed/settings/memory";
import { Route as PasswordsRoute } from "@/routes/_authed/settings/passwords";
import { Route as SettingsSkillsRoute } from "@/routes/_authed/settings/skills";
import { Route as ThisComputerRoute } from "@/routes/_authed/settings/this-computer";

/**
 * Addresses that are no longer pages but still have to lead somewhere: OpenBot Desktop opens
 * `/settings/this-computer`, the browser extension opens `/settings/browsers`, and the skills pages
 * were under Settings before they had their own place in the main menu. Every page the eight things
 * a Bot has replaced is here, with where its address leads now.
 */

function redirectOf(route: { options: { beforeLoad?: unknown } }, input = {}) {
  try {
    (route.options.beforeLoad as (input: unknown) => void)(input);
  } catch (thrown) {
    return (
      thrown as {
        options?: { to?: string; search?: unknown; params?: unknown };
      }
    ).options;
  }
  return undefined;
}

test.each([
  ["/settings/this-computer", ThisComputerRoute, "this-computer"],
  ["/settings/browsers", BrowsersRoute, "browsers"],
])("%s opens Settings → Computer at its section", (_from, route, hash) => {
  expect(redirectOf(route as never)).toMatchObject({
    to: "/settings/computer",
    hash,
  });
});

test("/settings/skills opens Skills and keeps which panel was open", () => {
  expect(redirectOf(SettingsSkillsRoute as never, { search: {} })?.to).toBe(
    "/skills",
  );
  expect(
    redirectOf(SettingsSkillsRoute as never, {
      search: { edit: "weekly-report" },
    }),
  ).toMatchObject({
    to: "/skills",
    search: { edit: "weekly-report" },
  });
  expect(
    redirectOf(SettingsSkillsRoute as never, { search: { new: true } }),
  ).toMatchObject({ to: "/skills", search: { new: true } });
});

test("the personal edition's skill pages under Settings open the same pages under Skills", () => {
  expect(redirectOf(NewSkillRoute as never)?.to).toBe("/skills/new");
  expect(
    redirectOf(SkillPageRoute as never, { params: { slug: "weekly-report" } }),
  ).toMatchObject({
    to: "/skills/$slug",
    params: { slug: "weekly-report" },
  });
});

/** Every other retired address with no choice to make, and where it leads now. */
test.each([
  ["/settings/passwords", PasswordsRoute, { to: "/settings/vault" }],
  ["/settings/credentials", CredentialsRoute, { to: "/settings/vault" }],
  ["/settings/learning", LearningRoute, { to: "/skills" }],
  ["/settings/memory", SettingsMemoryRoute, { to: "/memory" }],
  ["/capabilities", CapabilitiesRoute, { to: "/skills" }],
  ["/capabilities/memory", CapabilitiesMemoryRoute, { to: "/memory" }],
  [
    "/bots/:id/responsibilities",
    BotResponsibilitiesRoute,
    { to: "/bots/$agentId/routines", params: { agentId: "scout" } },
  ],
  [
    "/bots/:id/access",
    BotAccessRoute,
    { to: "/bots/$agentId/apps", params: { agentId: "scout" } },
  ],
] as const)("%s leads to its new place", (_from, route, to) => {
  expect(
    redirectOf(route as never, { params: { agentId: "scout" }, search: {} }),
  ).toMatchObject(to);
});

test("/capabilities/skills opens Skills and keeps which panel was open", () => {
  expect(
    redirectOf(CapabilitiesSkillsRoute as never, { search: {} }),
  ).toMatchObject({ to: "/skills", search: {} });
  expect(
    redirectOf(CapabilitiesSkillsRoute as never, {
      search: { edit: "weekly-report" },
    }),
  ).toMatchObject({ to: "/skills", search: { edit: "weekly-report" } });
});

/** Where `/settings/credentials/new` leads in an edition: the Vault's form where there is one. */
async function newKeyLeadsTo(edition: "team" | "personal") {
  const queryClient = new QueryClient();
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  try {
    await (
      NewCredentialRoute.options.beforeLoad as unknown as (input: {
        context: { queryClient: QueryClient };
      }) => Promise<void>
    )({ context: { queryClient } });
  } catch (thrown) {
    return (thrown as { options?: { to?: string } }).options?.to;
  }
  return undefined;
}

test.each([
  ["personal", "/settings/vault/new"],
  ["team", "/settings/vault"],
] as const)(
  "/settings/credentials/new in the %s edition leads to %s",
  async (edition, to) => {
    expect(await newKeyLeadsTo(edition)).toBe(to);
  },
);
