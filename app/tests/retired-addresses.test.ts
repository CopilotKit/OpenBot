import { expect, test } from "bun:test";
import { Route as SkillsRoute } from "@/routes/_authed/_app/skills";
import { Route as BrowsersRoute } from "@/routes/_authed/settings/browsers";
import { Route as ThisComputerRoute } from "@/routes/_authed/settings/this-computer";

/**
 * Addresses that are no longer pages but still have to lead somewhere: OpenBot Desktop opens
 * `/settings/this-computer`, the browser extension opens `/settings/browsers`, and a skill proposed
 * in a conversation links to `/skills`, in messages that stay in people's history.
 */

function redirectOf(route: { options: { beforeLoad?: unknown } }, input = {}) {
  try {
    (route.options.beforeLoad as (input: unknown) => void)(input);
  } catch (thrown) {
    return (thrown as { options?: { to?: string; search?: unknown } }).options;
  }
  return undefined;
}

test.each([
  ["/settings/this-computer", ThisComputerRoute],
  ["/settings/browsers", BrowsersRoute],
])("%s opens Settings → Computer", (_from, route) => {
  expect(redirectOf(route as never)?.to).toBe("/settings/computer");
});

test("/skills opens Settings → Skills and keeps which panel was open", () => {
  expect(redirectOf(SkillsRoute as never, { search: {} })?.to).toBe(
    "/settings/skills",
  );
  expect(
    redirectOf(SkillsRoute as never, { search: { edit: "weekly-report" } }),
  ).toMatchObject({
    to: "/settings/skills",
    search: { edit: "weekly-report" },
  });
  expect(
    redirectOf(SkillsRoute as never, { search: { new: true } }),
  ).toMatchObject({ to: "/settings/skills", search: { new: true } });
});
