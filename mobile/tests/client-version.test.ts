/**
 * The phone app carries its own copy of the rule that decides whether it and an OpenBot can work together (Metro bundles
 * only mobile/). This holds that copy to every case the other apps run, from the real deployment answers in
 * shared/fixtures/client-version/cases.json.
 */
import { expect, test } from "bun:test";
import {
  clientUpdateDetail,
  SECURITY_UPDATE_SENTENCE as SHARED_SECURITY_SENTENCE,
} from "../../shared/client-version";
import fixture from "../../shared/fixtures/client-version/cases.json";
import {
  compatibility,
  phoneUpdateDetail,
  SECURITY_UPDATE_SENTENCE,
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
  security?: boolean;
};

test("the phone app's rule decides every case in the shared fixture as the other apps do", () => {
  const deployments = fixture.deployments as Record<string, object>;
  const cases = fixture.cases as Case[];
  expect(cases.length).toBeGreaterThan(10);
  for (const one of cases) {
    const deployment = deployments[one.deployment];
    if (!deployment) throw new Error(`No deployment ${one.deployment}`);
    const decided = compatibility(deployment, one.client);
    expect({ case: one, decided }).toEqual({
      case: one,
      decided:
        one.fit === "app" && one.minimum
          ? {
              fit: "app",
              minimum: one.minimum,
              ...(one.security ? { security: true } : {}),
            }
          : { fit: one.fit },
    });
  }
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

test("a minimum raised for a security problem says so, in OpenBot's own words", () => {
  expect(phoneUpdateDetail("1.2.0", true)).toBe(
    "This version of OpenBot has a security problem. Update to keep using it.",
  );
  expect(phoneUpdateDetail("1.2.0", true)).toBe(
    clientUpdateDetail("mobile", "1.2.0", true),
  );
  expect(SECURITY_UPDATE_SENTENCE).toBe(SHARED_SECURITY_SENTENCE);
});
