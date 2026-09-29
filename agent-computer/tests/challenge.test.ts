import { expect, test } from "bun:test";
import { classifyChallenge } from "../src/challenge";

test("Cloudflare's explicit response signal requests help, generic 403 does not", () => {
  expect(
    classifyChallenge({
      cfMitigated: "challenge",
      text: "",
      visibleChallengeControl: false,
    })?.kind,
  ).toBe("cloudflare");
  expect(
    classifyChallenge({
      text: "403 Forbidden",
      visibleChallengeControl: false,
    }),
  ).toBeUndefined();
});
test("visible challenges require specific language and visible interactive evidence", () => {
  expect(
    classifyChallenge({
      text: "Verify you are human",
      visibleChallengeControl: true,
    })?.kind,
  ).toBe("visible-challenge");
  for (const text of [
    "An article about CAPTCHA",
    "Sign in to your account",
    "Access denied",
    "Unusual traffic detected",
  ]) {
    expect(
      classifyChallenge({ text, visibleChallengeControl: false }),
    ).toBeUndefined();
  }
  expect(
    classifyChallenge({
      text: "Verify you are human",
      visibleChallengeControl: false,
    }),
  ).toBeUndefined();
  expect(
    classifyChallenge({
      text: "An article about CAPTCHA",
      visibleChallengeControl: true,
    }),
  ).toBeUndefined();
});
