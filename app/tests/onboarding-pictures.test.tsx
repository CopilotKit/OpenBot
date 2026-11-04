import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { ComputerDemo } from "@/components/onboarding/demos/computer-demo";
import { IntroReel } from "@/components/onboarding/demos/intro-reel";
import { SelfHostDemo } from "@/components/onboarding/demos/self-host-demo";
import { TeamDemo } from "@/components/onboarding/demos/team-demo";
import { WelcomeDemo } from "@/components/onboarding/demos/welcome-demo";
import { agentKeys } from "@/lib/agents/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * Onboarding's pictures are pictures, and look it: nothing inside can be reached or hovered, their
 * colours are muted, and what they draw of a control is not the app's own button. Welcome plays
 * three of them in turn as one reel, and leaves the Bot computer's out where there is none.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** The team picture reads the Bots, so it gets a client that already holds an empty list. */
function withQueries(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(agentKeys.list(false), []);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const PICTURES: Array<[string, () => ReactNode]> = [
  ["The Welcome", () => <WelcomeDemo />],
  ["The Bot computer", () => <ComputerDemo />],
  ["The team", () => <TeamDemo />],
  ["The Talk to us", () => <SelfHostDemo />],
];

for (const [name, picture] of PICTURES) {
  test(`${name} picture is inert, muted, and offers nothing to press or hover`, () => {
    const view = render(withQueries(picture()));

    const image = view.getByRole("img");
    const drawn = image.firstElementChild as HTMLElement;
    expect(drawn.hasAttribute("inert")).toBe(true);
    expect(drawn.className).toContain("pointer-events-none");
    expect(drawn.className).toContain("saturate-75");
    expect(
      drawn.querySelectorAll("button, a, input, textarea, [tabindex]"),
    ).toHaveLength(0);
    // No hover state, and no fill of the app's own primary button.
    for (const element of drawn.querySelectorAll("*")) {
      const classes = element.getAttribute("class") ?? "";
      expect(classes).not.toContain("hover:");
      expect(classes).not.toMatch(/(^|\s)bg-primary(\s|$)/);
    }
  });
}

/** The scenes the reel plays, read from its dots, one a scene. */
const dots = (view: ReturnType<typeof render>) =>
  view.container.querySelectorAll("[data-intro-reel] > [aria-hidden] > span");

test("the intro reel plays three scenes, starting with the welcome, captioned in words", () => {
  const view = render(withQueries(<IntroReel />));

  expect(dots(view)).toHaveLength(3);
  const scene = view.container.querySelector("[data-scene]");
  expect(scene?.getAttribute("data-scene")).toBe("welcome");
  expect(
    view.getByText(
      "Ask in plain words. A Bot does the work and tells you when it's done.",
    ),
  ).toBeTruthy();
  // A picture and its caption: nothing in the reel to press.
  expect(
    view.container.querySelectorAll("button, a, input, textarea, [tabindex]"),
  ).toHaveLength(0);
});

test("without a Bot computer, the intro reel plays two scenes", () => {
  const view = render(withQueries(<IntroReel computer={false} />));

  expect(dots(view)).toHaveLength(2);
  expect(view.container.querySelector('[data-scene="computer"]')).toBeNull();
});
