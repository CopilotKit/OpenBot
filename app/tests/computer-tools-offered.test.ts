import { describe, expect, test } from "bun:test";
import { computerToolsOffered } from "@/lib/copilot/computer-available";

/**
 * Which computer tools a Bot is given in this conversation.
 *
 * Two different questions, and the screen used to ask only the first. WHOSE computer it is decides
 * whether this browser may drive it at all; the deployment's capability switches decide whether
 * anybody may. A Bot offered a tool the second question refuses reaches for it, is refused, and the
 * person watches a turn spent on an answer the deployment already knew — so the tool is not offered.
 *
 * Unresolved reads as allowed, in both halves: the server decides, and this only declines to offer
 * what it would certainly refuse.
 */

const mine = { visibility: "private", canManage: true } as const;
const somebodyElses = { visibility: "private", canManage: false } as const;
const everything = {
  cloudBrowser: true,
  cloudNetwork: true,
  cloudComputer: true,
};

describe("whose computer it is", () => {
  test("a Bot this person administers offers everything", () => {
    expect(
      computerToolsOffered({ profile: mine, capabilities: everything }),
    ).toEqual({ browser: true, navigate: true, computer: true });
  });

  test("a public Bot offers everything", () => {
    expect(
      computerToolsOffered({
        profile: { visibility: "public", canManage: false },
        capabilities: everything,
      }),
    ).toEqual({ browser: true, navigate: true, computer: true });
  });

  test("a teammate's Team Bot offers nothing", () => {
    // The computer carries its owner's signed-in browser; the server refuses every route on it.
    expect(
      computerToolsOffered({
        profile: somebodyElses,
        capabilities: everything,
      }),
    ).toEqual({ browser: false, navigate: false, computer: false });
  });

  test("a profile still loading offers everything", () => {
    expect(
      computerToolsOffered({ profile: undefined, capabilities: everything }),
    ).toEqual({ browser: true, navigate: true, computer: true });
  });
});

describe("what the deployment allows", () => {
  test("browser use switched off withdraws the browser tools", () => {
    expect(
      computerToolsOffered({
        profile: mine,
        capabilities: { ...everything, cloudBrowser: false },
      }),
    ).toEqual({ browser: false, navigate: false, computer: true });
  });

  test("network access switched off withdraws only opening pages", () => {
    // Clicking and typing on a page already open are still the browser, and still allowed.
    expect(
      computerToolsOffered({
        profile: mine,
        capabilities: { ...everything, cloudNetwork: false },
      }),
    ).toEqual({ browser: true, navigate: false, computer: true });
  });

  test("computer use switched off withdraws files and commands", () => {
    expect(
      computerToolsOffered({
        profile: mine,
        capabilities: { ...everything, cloudComputer: false },
      }),
    ).toEqual({ browser: true, navigate: true, computer: false });
  });

  test("capabilities still loading offer everything", () => {
    expect(
      computerToolsOffered({ profile: mine, capabilities: undefined }),
    ).toEqual({ browser: true, navigate: true, computer: true });
  });
});
