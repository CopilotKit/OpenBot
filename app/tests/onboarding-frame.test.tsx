import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { DemoStage } from "@/components/onboarding/demo-stage";
import { StepIntro } from "@/components/onboarding/onboarding-frame";
import {
  type OnboardingStep,
  OnboardingWizard,
} from "@/components/onboarding/onboarding-wizard";
import { settleReactWork } from "./settle-react-work";

/**
 * The frame every onboarding step sits in. One DOM, laid out two ways: on a phone, Back at the top
 * left, the steps as dashes and the buttons pinned to the bottom; from `lg` up, "Step N of M" and
 * the step's words on the left with Back and Continue under them, and its picture on the right.
 * happy-dom applies no stylesheet, so both layouts' parts are in the document here, and each test
 * reads the one it is about.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const plain = (id: string, title: string): OnboardingStep => ({
  id,
  title,
  intro: () => <StepIntro title={title}>About {title}.</StepIntro>,
  demo: () => <p>Picture of {title}</p>,
});

const STEPS = [
  plain("one", "One"),
  plain("two", "Two"),
  plain("three", "Three"),
];

function draw(props: Partial<Parameters<typeof OnboardingWizard>[0]> = {}) {
  return render(<OnboardingWizard steps={STEPS} {...props} />);
}

const progress = (view: ReturnType<typeof render>) =>
  view.getByRole("progressbar", { name: "Onboarding progress" });

const dashes = (view: ReturnType<typeof render>) =>
  Array.from(progress(view).querySelectorAll("span"));

const footer = (view: ReturnType<typeof render>) => {
  const found = view.container.querySelector("footer");
  if (!found) throw new Error("no footer");
  return found;
};

/** The primary and the second button, in the footer, without the desktop's Back. */
const footerButtons = (view: ReturnType<typeof render>) =>
  Array.from(footer(view).querySelectorAll("button")).filter(
    (button) => !button.hasAttribute("data-onboarding-back"),
  );

const primary = (view: ReturnType<typeof render>) => {
  const found = footer(view).querySelector<HTMLButtonElement>(
    "[data-onboarding-primary]",
  );
  if (!found) throw new Error("no primary");
  return found;
};

/** The phone's Back, at the top left. */
const phoneBack = (view: ReturnType<typeof render>) =>
  view.container.querySelector<HTMLButtonElement>(
    '[data-onboarding-back="phone"]',
  );

/** The desktop's Back, beside Continue. */
const desktopBack = (view: ReturnType<typeof render>) =>
  view.container.querySelector<HTMLButtonElement>(
    '[data-onboarding-back="desktop"]',
  );

/** "Step N of M", the desktop's way to the list of steps. */
const stepsButton = (view: ReturnType<typeof render>) => {
  const found = view.container.querySelector<HTMLButtonElement>(
    "[data-onboarding-steps]",
  );
  if (!found) throw new Error("no step menu");
  return found;
};

/** The list of steps, opened over the page. */
const stepList = (view: ReturnType<typeof render>) => {
  fireEvent.click(stepsButton(view));
  return view.getByRole("navigation", { name: "Onboarding steps" });
};

test("the first step has no Back, and the dashes say step 1", () => {
  const view = draw();

  expect(phoneBack(view)).toBeNull();
  expect(desktopBack(view)).toBeNull();
  expect(progress(view).getAttribute("aria-valuetext")).toBe("Step 1 of 3");
  expect(dashes(view)).toHaveLength(3);
  expect(dashes(view).map((dash) => dash.hasAttribute("data-current"))).toEqual(
    [true, false, false],
  );
});

test("on a phone, Back sits in the top bar and the button is pinned below the step", () => {
  const view = draw({ initialStepId: "two" });

  expect(phoneBack(view)?.closest("header")).not.toBeNull();
  expect(progress(view).closest("header")).not.toBeNull();
  expect(primary(view).textContent).toBe("Continue");
  // Below the step's words and its picture in document order, which is where it sits on screen.
  const heading = view.getByRole("heading", { name: "Two" });
  const picture = view.getByText("Picture of Two");
  for (const before of [heading, picture]) {
    expect(
      before.compareDocumentPosition(primary(view)) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }
  // No step here is optional, so nothing offers to skip it.
  expect(view.queryByRole("button", { name: "Not now" })).toBeNull();
});

test("the step's words and its picture sit in their own panes, words first", () => {
  const view = draw({ initialStepId: "two" });

  const intro = view.container.querySelector("[data-onboarding-intro]");
  const demo = view.container.querySelector("[data-onboarding-demo]");
  expect(intro?.textContent).toContain("About Two.");
  expect(demo?.textContent).toBe("Picture of Two");
  expect(
    intro &&
      demo &&
      intro.compareDocumentPosition(demo) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  // The desktop's two columns: the words on the left, with the buttons at the bottom of their
  // pane, and the picture filling the right, held in view, with its border on the words' side.
  expect(intro?.className).toContain("lg:col-start-1");
  expect(demo?.className).toContain("lg:col-start-2");
  expect(demo?.className).toContain("lg:sticky");
  expect(demo?.className).toContain("lg:border-l");
  expect(demo?.className).not.toContain("lg:border-r");
  const footer = view.container.querySelector("footer");
  expect(footer?.className).toContain("lg:col-start-1");
  expect(footer?.className).toContain("lg:row-start-4");
  const header = view.container.querySelector("header");
  expect(header?.className).toContain("lg:col-start-1");
});

test("a step with its picture first puts it above the heading on a phone", () => {
  const view = draw({
    initialStepId: "two",
    steps: [STEPS[0], { ...plain("two", "Two"), demoFirst: true }, STEPS[2]],
  });

  const intro = view.container.querySelector("[data-onboarding-intro]");
  const demo = view.container.querySelector("[data-onboarding-demo]");
  expect(demo?.className).toContain("row-start-2");
  expect(intro?.className).toContain("row-start-3");
  // On a desktop it is still the right-hand pane, and the words still head the left.
  expect(intro?.className).toContain("lg:row-start-2");
  expect(demo?.className).toContain("lg:col-start-2");
  // Without the phone's margin under it, which would stop the stretched pane short of the bottom.
  expect(demo?.className).toContain("lg:my-0");
});

test("Continue moves on, the dashes follow, and focus lands on the new heading", async () => {
  const view = draw();

  fireEvent.click(primary(view));

  const heading = await view.findByRole("heading", { name: "Two" });
  expect(progress(view).getAttribute("aria-valuetext")).toBe("Step 2 of 3");
  expect(dashes(view).map((dash) => dash.hasAttribute("data-current"))).toEqual(
    [false, true, false],
  );
  await waitFor(() => expect(document.activeElement).toBe(heading));
  expect(phoneBack(view)).not.toBeNull();
});

test("Back returns, and hides again on the first step", async () => {
  const view = draw({ initialStepId: "two" });

  fireEvent.click(phoneBack(view) as HTMLButtonElement);

  await view.findByRole("heading", { name: "One" });
  expect(progress(view).getAttribute("aria-valuetext")).toBe("Step 1 of 3");
  expect(phoneBack(view)).toBeNull();
});

test("a single step has no step list and no dashes, since there is nowhere else to be", () => {
  const view = draw({ steps: [plain("only", "Only")] });

  expect(view.getByRole("heading", { name: "Only" })).toBeTruthy();
  expect(view.container.querySelector("[data-onboarding-steps]")).toBeNull();
  expect(view.queryByRole("progressbar")).toBeNull();
  expect(phoneBack(view)).toBeNull();
  expect(desktopBack(view)).toBeNull();
  // The product's name still heads the desktop's pane.
  expect(view.container.querySelector("header")?.textContent).toContain(
    "OpenBot",
  );
});

test("a step that joins the list later does not move somebody off theirs", () => {
  const view = draw({ initialStepId: "two" });

  view.rerender(
    <OnboardingWizard
      steps={[...STEPS.slice(0, 2), plain("local", "Local"), ...STEPS.slice(2)]}
    />,
  );

  expect(view.getByRole("heading", { name: "Two" })).not.toBeNull();
  expect(progress(view).getAttribute("aria-valuetext")).toBe("Step 2 of 4");
});

/** Three steps where the second is optional, the way Talk to us is. */
const OPTIONAL: OnboardingStep[] = [
  plain("one", "One"),
  {
    ...plain("apps", "Connect your apps"),
    secondary: { label: "Not now" },
    footnote: "You can connect more apps later.",
  },
  plain("three", "Three"),
];

test("an optional step says Continue, with Not now beside it, the same size", () => {
  const view = draw({ initialStepId: "apps", steps: OPTIONAL });

  const [continueButton, notNow] = footerButtons(view);
  expect(footerButtons(view)).toHaveLength(2);
  expect(continueButton?.textContent).toBe("Continue");
  expect(notNow?.textContent).toBe("Not now");
  // Under the primary on a phone, in the same column, and drawn the same height and shape.
  expect(continueButton?.parentElement).toBe(notNow?.parentElement ?? null);
  expect(
    continueButton &&
      notNow &&
      continueButton.compareDocumentPosition(notNow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  for (const shape of ["h-[52px]", "w-full", "rounded-full"]) {
    expect(continueButton?.className).toContain(shape);
    expect(notNow?.className).toContain(shape);
  }
});

test("the footnote sits just above the buttons", () => {
  const view = draw({ initialStepId: "apps", steps: OPTIONAL });

  const footnote = view.getByText("You can connect more apps later.");
  expect(footnote.closest("footer")).not.toBeNull();
  expect(
    footnote.compareDocumentPosition(primary(view)) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("Continue and Not now both move on", async () => {
  const continued = draw({ initialStepId: "apps", steps: OPTIONAL });
  fireEvent.click(continued.getByRole("button", { name: "Continue" }));
  expect(await continued.findByRole("heading", { name: "Three" })).toBeTruthy();
  cleanup();

  const skipped = draw({ initialStepId: "apps", steps: OPTIONAL });
  fireEvent.click(skipped.getByRole("button", { name: "Not now" }));
  expect(await skipped.findByRole("heading", { name: "Three" })).toBeTruthy();
});

test("a step's own action decides when to move on", async () => {
  let handed: (() => void) | null = null;
  const view = draw({
    initialStepId: "apps",
    steps: [
      OPTIONAL[0] as OnboardingStep,
      {
        ...(OPTIONAL[1] as OnboardingStep),
        primaryLabel: "Turn on notifications",
        onPrimary: (next) => {
          handed = next;
        },
      },
      OPTIONAL[2] as OnboardingStep,
    ],
  });

  fireEvent.click(view.getByRole("button", { name: "Turn on notifications" }));
  // Nothing moved: the step holds the move until its own action is done.
  expect(view.getByRole("heading", { name: "Connect your apps" })).toBeTruthy();
  act(() => (handed as unknown as () => void)());
  expect(await view.findByRole("heading", { name: "Three" })).toBeTruthy();
});

test("a move handed out on one step does nothing once somebody has left it", async () => {
  let handed: (() => void) | null = null;
  const view = draw({
    initialStepId: "apps",
    steps: [
      OPTIONAL[0] as OnboardingStep,
      {
        ...(OPTIONAL[1] as OnboardingStep),
        onPrimary: (next) => {
          handed = next;
        },
      },
      OPTIONAL[2] as OnboardingStep,
    ],
  });

  fireEvent.click(view.getByRole("button", { name: "Continue" }));
  fireEvent.click(phoneBack(view) as HTMLButtonElement);
  await view.findByRole("heading", { name: "One" });
  act(() => (handed as unknown as () => void)());
  await settleReactWork();
  expect(view.getByRole("heading", { name: "One" })).toBeTruthy();
});

test("a done primary reads green with a check", () => {
  const view = draw({
    initialStepId: "apps",
    steps: [
      OPTIONAL[0] as OnboardingStep,
      {
        ...plain("apps", "Get notified"),
        primaryLabel: "Notifications on",
        primaryDone: true,
      },
      OPTIONAL[2] as OnboardingStep,
    ],
  });

  const [done] = footerButtons(view);
  expect(footerButtons(view)).toHaveLength(1);
  expect(done?.textContent).toBe("Notifications on");
  expect(done?.hasAttribute("data-done")).toBe(true);
  expect(done?.className).toContain("bg-emerald-500/10");
});

test("an optional step keeps Not now's place when it goes, so the primary doesn't move", () => {
  const view = draw({
    initialStepId: "apps",
    steps: [
      OPTIONAL[0] as OnboardingStep,
      {
        ...plain("apps", "Get notified"),
        primaryLabel: "Notifications on",
        primaryDone: true,
        optional: true,
      },
      OPTIONAL[2] as OnboardingStep,
    ],
  });

  expect(footerButtons(view)).toHaveLength(1);
  const slot = footer(view).querySelector("[data-onboarding-secondary-slot]");
  expect(slot?.className).toContain("h-[52px]");
  expect(slot?.getAttribute("aria-hidden")).toBe("true");
});

test("a waiting primary shows a spinner, says it is busy, and can't be pressed again", () => {
  const view = draw({
    initialStepId: "apps",
    steps: [
      OPTIONAL[0] as OnboardingStep,
      {
        ...plain("apps", "Get notified"),
        primaryLabel: "Turn on notifications",
        primaryPending: true,
        secondary: { label: "Not now" },
      },
      OPTIONAL[2] as OnboardingStep,
    ],
  });

  const waiting = primary(view);
  expect(waiting.getAttribute("aria-busy")).toBe("true");
  expect(waiting.disabled).toBe(true);
  expect(waiting.querySelector(".animate-spin")).not.toBeNull();
});

test("a step with a form submits it from the frame's primary, with Back beside it as anywhere else", () => {
  const submitted: string[] = [];
  const view = draw({
    initialStepId: "three",
    steps: [
      ...STEPS.slice(0, 2),
      {
        ...plain("three", "Three"),
        intro: () => (
          <StepIntro
            after={
              <form
                id="three-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitted.push("three");
                }}
              />
            }
          />
        ),
        primaryForm: "three-form",
        primaryLabel: "Get started",
      },
    ],
  });

  const button = primary(view);
  expect(button.getAttribute("type")).toBe("submit");
  expect(button.getAttribute("form")).toBe("three-form");
  // Back is in the same row, before it, as on every other step.
  const back = desktopBack(view);
  expect(back?.parentElement).toBe(button.parentElement);
  expect(back?.className).toContain("lg:order-first");

  fireEvent.click(button);
  expect(submitted).toEqual(["three"]);
  // The form decides: the frame doesn't move on by itself.
  expect(view.getByRole("heading", { name: "Three" })).toBeTruthy();
});

test("held by its caller, it asks to move and draws whatever step it is handed", async () => {
  const asked: Array<[string, string]> = [];
  const view = render(
    <OnboardingWizard
      onMove={(to, way) => asked.push([to, way])}
      stepId="apps"
      steps={OPTIONAL}
    />,
  );

  fireEvent.click(view.getByRole("button", { name: "Continue" }));
  fireEvent.click(phoneBack(view) as HTMLButtonElement);
  expect(asked).toEqual([
    ["three", "forward"],
    ["one", "back"],
  ]);
  // Nothing moved until the caller said so.
  expect(view.getByRole("heading", { name: "Connect your apps" })).toBeTruthy();

  view.rerender(
    <OnboardingWizard
      onMove={(to, way) => asked.push([to, way])}
      stepId="one"
      steps={OPTIONAL}
    />,
  );
  const heading = await view.findByRole("heading", { name: "One" });
  await waitFor(() => expect(document.activeElement).toBe(heading));
});

/*
 * THE DESKTOP'S STEP LIST, ON DEMAND. One line says where somebody is; pressing it opens every step
 * by name, the one on screen marked as the current step, the ones before it ticked. A step already
 * reached is a button back to it; one ahead is only its name.
 */

test("on a desktop, where somebody is takes one line, and opens the list of steps", () => {
  const view = draw({ initialStepId: "two" });

  expect(stepsButton(view).textContent).toBe("Step 2 of 3");
  // Shut until asked for.
  expect(view.queryByRole("navigation", { name: "Onboarding steps" })).toBe(
    null,
  );
  const items = within(stepList(view)).getAllByRole("listitem");
  // What the ticks and the numbers show is said in words: done, and not yet available.
  expect(items.map((item) => item.textContent?.replace(/^\d/, ""))).toEqual([
    "One, done",
    "Two",
    "Three, not yet available",
  ]);
  const current = view.container.ownerDocument.querySelector(
    '[aria-current="step"]',
  );
  expect(current?.textContent).toContain("Two");
  // The line is the desktop's, the dashes the phone's.
  expect(stepsButton(view).parentElement?.className).toContain(
    "hidden lg:flex",
  );
  expect(progress(view).parentElement?.className).toContain("lg:hidden");
});

/*
 * THE STEP COMES FIRST. The whole list used to sit above the heading, and on a laptop the step's
 * words started 300 to 640 px down the screen.
 *
 * WHAT THIS CAN'T PROVE. happy-dom lays nothing out, so no test here can show where the heading
 * lands or that the buttons fit on any given screen. It pins the structure that does it: nothing
 * but the one line sits above the heading, the list is not in the page until it is opened, and
 * neither the words nor the buttons scroll or shrink. That every step's buttons are on screen at
 * 1280 by 800 and 1280 by 700, with the heading near the top, was checked in a browser, step by step.
 */
test("on a desktop, only the one line sits above the step's heading, and the list opens over the page", () => {
  const view = draw({ initialStepId: "two" });

  const frame = view.container.querySelector("[data-onboarding-frame]");
  expect(frame?.className).toContain("lg:h-svh");
  expect(frame?.className).toContain("lg:grid-rows-[auto_auto_1fr_auto]");
  // Above the heading, the header holds the phone's bar and the desktop's one line, nothing more.
  const header = view.container.querySelector("header");
  expect(header?.querySelectorAll("li")).toHaveLength(0);
  expect(header?.querySelector("nav")).toBeNull();
  const heading = view.getByRole("heading", { name: "Two" });
  expect(
    stepsButton(view).compareDocumentPosition(heading) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  // Opened, the list is drawn outside the frame, so nothing in it moves.
  const list = stepList(view);
  expect(frame?.contains(list)).toBe(false);
  const demo = view.container.querySelector("[data-onboarding-demo]");
  expect(demo?.className).toContain("lg:max-h-svh");
  const intro = view.container.querySelector("[data-onboarding-intro]");
  for (const part of [intro, footer(view)]) {
    expect(part?.className).not.toMatch(/overflow|min-h-0|max-h-/);
  }
});

test("a step already reached can be picked from the list; one ahead cannot", async () => {
  const view = draw({ initialStepId: "two" });

  const list = within(stepList(view));
  expect(list.queryByRole("button", { name: /Three/ })).toBeNull();
  expect(list.queryByRole("button", { name: /Two/ })).toBeNull();

  fireEvent.click(list.getByRole("button", { name: /^One\W+done$/ }));
  const heading = await view.findByRole("heading", { name: "One" });
  await waitFor(() => expect(document.activeElement).toBe(heading));
  // Picking closes the list.
  await waitFor(() =>
    expect(
      view.queryByRole("navigation", { name: "Onboarding steps" }),
    ).toBeNull(),
  );

  // Two has been seen now, so it is a way back; Three still is not.
  const again = within(stepList(view));
  expect(again.queryByRole("button", { name: /Three/ })).toBeNull();
  fireEvent.click(again.getByRole("button", { name: "Two" }));
  expect(await view.findByRole("heading", { name: "Two" })).toBeTruthy();
});

test("held by its caller, a pick from the list is asked for like Back", () => {
  const asked: Array<[string, string]> = [];
  const view = render(
    <OnboardingWizard
      onMove={(to, way) => asked.push([to, way])}
      stepId="three"
      steps={STEPS}
    />,
  );

  fireEvent.click(
    within(stepList(view)).getByRole("button", { name: /^One\W+done$/ }),
  );
  expect(asked).toEqual([["one", "back"]]);
});

test("on a desktop, Back sits beside Continue, before it, and Back on a phone is hidden there", () => {
  const view = draw({ initialStepId: "two" });

  const back = desktopBack(view);
  expect(back?.closest("footer")).not.toBeNull();
  expect(back?.textContent).toBe("Back");
  expect(back?.className).toContain("hidden");
  expect(back?.className).toContain("lg:inline-flex");
  expect(back?.className).toContain("lg:order-first");
  expect(phoneBack(view)?.parentElement?.className).toContain("lg:hidden");

  fireEvent.click(back as HTMLButtonElement);
  expect(view.getByRole("heading", { name: "One" })).toBeTruthy();
});

test("focus rings on the step list, the phone's Back and the checklist's links are full strength", () => {
  const view = draw({ initialStepId: "two" });

  const rings = [
    phoneBack(view)?.className,
    within(stepList(view)).getByRole("button", { name: /^One\W+done$/ })
      .className,
  ];
  for (const ring of rings) {
    expect(ring).toContain("focus-visible:ring-ring");
    // Half strength is about 2.4:1 against the page, under the 3:1 a focus ring needs.
    expect(ring).not.toContain("ring-ring/50");
  }
});

/*
 * THE DEMOS' CLOCK. A picture moves only while somebody can see it: on screen, in a shown tab.
 */

/** An `IntersectionObserver` that reports only what the test tells it to. */
class Sight {
  static all: Sight[] = [];
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds = [];
  targets: Element[] = [];
  constructor(private readonly callback: IntersectionObserverCallback) {
    Sight.all.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve() {}
  disconnect() {
    this.targets = [];
  }
  takeRecords() {
    return [];
  }
  static show(target: Element, isIntersecting: boolean) {
    for (const sight of Sight.all) {
      if (!sight.targets.includes(target)) continue;
      sight.callback(
        [{ target, isIntersecting } as IntersectionObserverEntry],
        sight as unknown as IntersectionObserver,
      );
    }
  }
}

function drawStage() {
  return render(
    <DemoStage beatMs={20} beats={3} kind="test" label="A test picture">
      {({ beat, playing }) => (
        <p>
          Beat {beat} {playing ? "playing" : "still"}
        </p>
      )}
    </DemoStage>,
  );
}

const stageOf = (view: ReturnType<typeof render>) =>
  view.container.querySelector("[data-demo]") as HTMLElement;

test("a demo is one picture, read by its label, with nothing inside to reach", () => {
  const view = drawStage();

  const picture = view.getByRole("img", { name: "A test picture" });
  expect(picture.firstElementChild?.hasAttribute("inert")).toBe(true);
});

test("a demo plays its beats while on screen, and holds still once scrolled away", async () => {
  const original = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver =
    Sight as unknown as typeof IntersectionObserver;
  try {
    const view = drawStage();
    const stage = stageOf(view);
    expect(stage.hasAttribute("data-playing")).toBe(true);
    await waitFor(() =>
      expect(stage.getAttribute("data-demo-beat")).not.toBe("0"),
    );

    act(() => Sight.show(stage, false));
    expect(stage.hasAttribute("data-playing")).toBe(false);
    expect(view.getByText(/still/)).toBeTruthy();
    const held = stage.getAttribute("data-demo-beat");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(stage.getAttribute("data-demo-beat")).toBe(held);

    act(() => Sight.show(stage, true));
    expect(stage.hasAttribute("data-playing")).toBe(true);
  } finally {
    globalThis.IntersectionObserver = original;
    Sight.all = [];
  }
});

test("a demo in a hidden tab holds still until the tab is shown", async () => {
  const view = drawStage();
  const stage = stageOf(view);
  const hidden = Object.getOwnPropertyDescriptor(Document.prototype, "hidden");
  try {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(stage.hasAttribute("data-playing")).toBe(false);
    const held = stage.getAttribute("data-demo-beat");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(stage.getAttribute("data-demo-beat")).toBe(held);
  } finally {
    Reflect.deleteProperty(document, "hidden");
    if (hidden) Object.defineProperty(Document.prototype, "hidden", hidden);
  }
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(stage.hasAttribute("data-playing")).toBe(true);
});
