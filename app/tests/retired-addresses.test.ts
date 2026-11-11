import { expect, test } from "bun:test";
import { Route as SkillPageRoute } from "@/routes/_authed/settings/_personal/skills_.$slug";
import { Route as NewSkillRoute } from "@/routes/_authed/settings/_personal/skills_.new";
import { Route as BrowsersRoute } from "@/routes/_authed/settings/browsers";
import { Route as SettingsSkillsRoute } from "@/routes/_authed/settings/skills";
import { Route as ThisComputerRoute } from "@/routes/_authed/settings/this-computer";

/**
 * Addresses that are no longer pages but still have to lead somewhere: OpenBot Desktop opens
 * `/settings/this-computer`, the browser extension opens `/settings/browsers`, and the skills pages
 * were under Settings before they had their own place in the main menu.
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
