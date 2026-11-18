/**
 * The phone app carries its own copy of the rule that decides whether it and an OpenBot can work together (Metro bundles
 * only mobile/). This holds that copy to every case the other apps run, from the real deployment answers in
 * shared/fixtures/client-version/cases.json.
 */
import { expect, test } from "bun:test";
import { clientUpdateDetail } from "../../shared/client-version";
import fixture from "../../shared/fixtures/client-version/cases.json";
import {
  compatibility,
  isOpenBotCapabilities,
  phoneUpdateDetail,
} from "../src/client-version";

type Case = {
  deployment: string;
  client: {
    kind: "web" | "desktop" | "mobile" | "recorder";
    version: string;
    speaks?: string[];
  };
  fit: "ok" | "app" | "server";
  minimum?: string;
};

test("the phone app's rule decides every case in the shared fixture as the other apps do", () => {
  const deployments = fixture.deployments as Record<string, object>;
  const cases = fixture.cases as Case[];
  expect(cases.length).toBeGreaterThan(10);
  for (const one of cases) {
    const deployment =
      one.deployment === "before-v2"
        ? ("before-v2" as const)
        : deployments[one.deployment];
    if (!deployment) throw new Error(`No deployment ${one.deployment}`);
    const decided = compatibility(deployment, one.client);
    expect({ case: one, decided }).toEqual({
      case: one,
      decided:
        one.fit === "app" && one.minimum
          ? { fit: "app", minimum: one.minimum }
          : { fit: one.fit },
    });
  }
});

test("an OpenBot from before the v2 API is told apart by its capabilities answer, and nothing else is taken for one", () => {
  expect(isOpenBotCapabilities(fixture["before-v2-capabilities"])).toBe(true);
  for (const other of [
    null,
    "OpenBot",
    { status: "ok" },
    { edition: "team" },
    { mode: "intelligence", generativeUi: "yes", edition: "team" },
  ])
    expect(isOpenBotCapabilities(other)).toBe(false);
});

test("the update screen names the release it needs when OpenBot said one, in OpenBot's own words for the phone app", () => {
  expect(phoneUpdateDetail("1.2.0")).toBe(
    "This OpenBot needs the OpenBot phone app 1.2.0 or later. Update OpenBot, then try again.",
  );
  // The sentence a server refuses the phone app with, so the screen says the same whichever way it learned.
  expect(phoneUpdateDetail("v1.2.0")).toBe(
    clientUpdateDetail("mobile", "1.2.0"),
  );
  expect(phoneUpdateDetail(undefined)).toBe(
    "This OpenBot needs a newer OpenBot phone app. Update OpenBot, then try again.",
  );
});
