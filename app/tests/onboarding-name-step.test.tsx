import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { NameOrb, useNameStep } from "@/components/onboarding/name-step";
import { StepIntro } from "@/components/onboarding/onboarding-frame";
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";
import { authKeys } from "@/lib/auth/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * Onboarding's name step. Its button is the frame's, so Back sits beside Get started as it does
 * beside Continue on every other step. Get started saves the name, then finishes: Saving… while it
 * saves, and All set, green with a check, while the orb shows done.
 */

beforeAll(() => GlobalRegistrator.register());
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function client(needsName = true) {
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  query.setQueryData(authKeys.currentUser(), {
    id: "existing-user",
    email: "dev@openbot.local",
    name: needsName ? "dev@openbot.local" : "Sam",
    needsName,
    onboarding: { completedAt: null, step: 9 },
  });
  return query;
}

/** The name step after one plain step, in the real frame, with a finish the test controls. */
function NameOnboarding({
  finish,
  from = "name",
}: {
  finish: (setFinished: (finished: boolean) => void) => Promise<void>;
  from?: "notify" | "name";
}) {
  const [finished, setFinished] = useState(false);
  const name = useNameStep({
    finish: () => finish(setFinished),
    finished,
  });
  return (
    <OnboardingWizard
      initialStepId={from}
      steps={[
        {
          id: "notify",
          title: "Get notified",
          intro: () => <StepIntro />,
        },
        name,
      ]}
    />
  );
}

function draw(
  finish: (setFinished: (finished: boolean) => void) => Promise<void>,
  needsName = true,
  from: "notify" | "name" = "name",
) {
  return render(
    <QueryClientProvider client={client(needsName)}>
      <NameOnboarding finish={finish} from={from} />
    </QueryClientProvider>,
  );
}

const primary = (view: ReturnType<typeof render>) =>
  view.container.querySelector(
    "[data-onboarding-primary]",
  ) as HTMLButtonElement;

const saved = () =>
  Object.assign(
    async () => Response.json({ profile: { name: "Sam", needsName: false } }),
    { preconnect: originalFetch.preconnect },
  );

test("it starts empty for a placeholder profile, and Get started waits for a name", () => {
  const view = draw(async () => {});

  expect(
    view.getByRole("heading", { name: "What should we call you?" }),
  ).toBeTruthy();
  expect((view.getByLabelText("Name") as HTMLInputElement).value).toBe("");
  expect(primary(view).textContent).toBe("Get started");
  expect(primary(view).disabled).toBe(true);
});

test("a saved name is kept when the step is revisited", () => {
  const view = draw(async () => {}, false);

  expect((view.getByLabelText("Name") as HTMLInputElement).value).toBe("Sam");
  expect(primary(view).disabled).toBe(false);
});

test("Back sits beside Get started, before it, as on every other step", () => {
  const view = draw(async () => {});

  const back = view.container.querySelector('[data-onboarding-back="desktop"]');
  expect(back?.parentElement).toBe(primary(view).parentElement);
  expect(back?.className).toContain("lg:order-first");
  expect(primary(view).getAttribute("type")).toBe("submit");
});

test("Get started saves first, then finishes, and reads All set while the orb shows done", async () => {
  let release: (response: Response) => void = () => {};
  const response = new Promise<Response>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = Object.assign(async () => response, {
    preconnect: originalFetch.preconnect,
  });
  let finishes = 0;
  let endFinish: () => void = () => {};
  const view = draw(async (setFinished) => {
    finishes += 1;
    setFinished(true);
    await new Promise<void>((resolve) => {
      endFinish = resolve;
    });
  }, false);

  fireEvent.click(primary(view));
  await waitFor(() => expect(primary(view).textContent).toBe("Saving…"));
  expect(primary(view).disabled).toBe(true);
  expect(finishes).toBe(0);

  release(Response.json({ profile: { name: "Sam", needsName: false } }));
  await waitFor(() => expect(primary(view).textContent).toBe("All set"));
  // Done, not a disabled Saving…: green with a check while the orb plays.
  expect(primary(view).hasAttribute("data-done")).toBe(true);
  expect(primary(view).disabled).toBe(false);
  expect(primary(view).querySelector("svg")).not.toBeNull();
  expect(finishes).toBe(1);

  // A press during the finish does nothing.
  fireEvent.click(primary(view));
  await settleReactWork();
  expect(finishes).toBe(1);
  endFinish();
});

test("a save that fails is said under the field, and the step stays", async () => {
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "Save failed" }, { status: 500 }),
    { preconnect: originalFetch.preconnect },
  );
  let finishes = 0;
  const view = draw(async () => {
    finishes += 1;
  }, false);

  fireEvent.click(primary(view));

  expect((await view.findByRole("alert")).textContent).toBe("Save failed");
  expect(finishes).toBe(0);
  expect(primary(view).textContent).toBe("Get started");
  expect((view.getByLabelText("Name") as HTMLInputElement).value).toBe("Sam");
});

test("a completion that fails is said under the field too", async () => {
  globalThis.fetch = saved();
  const view = draw(async () => {
    throw new Error("Onboarding could not be saved");
  }, false);

  fireEvent.click(primary(view));

  expect((await view.findByRole("alert")).textContent).toBe(
    "Onboarding could not be saved",
  );
  expect(primary(view).textContent).toBe("Get started");
});

/**
 * A click as a browser makes it. React redraws between the click's listeners and the button's own
 * action (the browser runs microtasks in between), so the button's action reads the button as it is
 * after the redraw: if the very element clicked is now a form's submit button, the browser submits
 * that form. `fireEvent` alone redraws only after both, so this runs the action afterwards.
 */
function browserClick(button: HTMLButtonElement) {
  fireEvent.click(button);
  const form = button.isConnected && button.type === "submit" && button.form;
  if (form) act(() => form.requestSubmit(button));
}

test("Continue on the step before moves on to the name, and submits nothing", async () => {
  let fetched = 0;
  globalThis.fetch = Object.assign(
    async () => {
      fetched += 1;
      return Response.json({ profile: { name: "Sam", needsName: false } });
    },
    { preconnect: originalFetch.preconnect },
  );
  let finishes = 0;
  // A saved name, so the name step's form could be submitted at once.
  const view = draw(
    async () => {
      finishes += 1;
    },
    false,
    "notify",
  );

  browserClick(
    view.getByRole("button", { name: "Continue" }) as HTMLButtonElement,
  );
  await settleReactWork();

  expect(
    view.getByRole("heading", { name: "What should we call you?" }),
  ).toBeTruthy();
  expect(primary(view).textContent).toBe("Get started");
  expect(fetched).toBe(0);
  expect(finishes).toBe(0);
});

test("the orb is OpenBot's own, listening, and shows done when onboarding ends", () => {
  const view = render(<NameOrb />);
  const state = () =>
    view.container.querySelector<HTMLElement>("[data-state]") as HTMLElement;
  // OpenBot's own mark, as on sign-in: AgentOrb, not a Bot's orb.
  expect(state().querySelector(".agent-orb")).not.toBeNull();
  expect(state().getAttribute("data-state")).toBe("listening");
  expect(view.container.querySelector("[data-onboarding-finish]")).toBeNull();

  view.rerender(<NameOrb finished />);
  expect(state().getAttribute("data-state")).toBe("done");
  expect(state().closest("[data-onboarding-finish]")).not.toBeNull();
});
