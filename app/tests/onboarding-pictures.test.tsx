import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { ApprovalDemo } from "@/components/onboarding/demos/approval-demo";
import { WelcomeDemo } from "@/components/onboarding/demos/welcome-demo";
import { useNotifyStep } from "@/components/onboarding/notify-step";
import { settleReactWork } from "./settle-react-work";

/**
 * Onboarding's pictures are pictures, and look it: nothing inside can be reached or hovered, their
 * colours are muted, and what they draw of a control is not the app's own button. Get notified's is
 * a browser's notification, since that is the only place its footnote says they show.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function NotifyPicture() {
  return <>{useNotifyStep("General Assistant").demo?.()}</>;
}

const PICTURES: Array<[string, () => ReactNode]> = [
  ["The Welcome", () => <WelcomeDemo />],
  ["The approval step", () => <ApprovalDemo />],
  ["The Get notified", () => <NotifyPicture />],
];

for (const [name, picture] of PICTURES) {
  test(`${name} picture is inert, muted, and offers nothing to press or hover`, () => {
    const view = render(picture());

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

test("the approval picture's answers still say what the real card says", () => {
  const view = render(<ApprovalDemo />);

  const answers = Array.from(
    view.container.querySelectorAll<HTMLElement>("[inert] span"),
  ).filter((span) =>
    ["Decline", "Allow once", "Always allow here"].includes(
      span.textContent ?? "",
    ),
  );
  expect(answers.map((answer) => answer.textContent)).toEqual([
    "Decline",
    "Allow once",
    "Always allow here",
  ]);
});

test("Get notified shows a notification in a browser window, not on a phone", () => {
  const view = render(<NotifyPicture />);

  expect(view.container.querySelector("[data-ghost-browser]")).not.toBeNull();
  expect(view.container.querySelector("[data-ghost-phone]")).toBeNull();
  const notification = view.container.querySelector(
    "[data-notification-preview]",
  );
  expect(notification?.textContent).toContain("General Assistant needs you");
  // Named by the site it comes from, as a browser's notification is.
  expect(notification?.textContent).toContain("localhost:3010");
  expect(
    view.getByRole("img", {
      name: "A notification from OpenBot: General Assistant needs you. 1 question, 1 approval.",
    }),
  ).toBeTruthy();
});
