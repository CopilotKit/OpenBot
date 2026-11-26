import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BoxLineView } from "@/components/routines/box-line";
import type { RoutineDraft } from "@/lib/api/generated/model";
import type { BoxLine } from "@/lib/routines/box";
import type { MadeRoutine } from "@/lib/routines/mutations";
import { settleReactWork } from "./settle-react-work";

/**
 * The line under the Routines box says what the box did with a sentence and offers at most one thing
 * beside the words: open what it made, finish it in the form, or connect the app it needs.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const BOT = { name: "Atlas", avatarSeed: "atlas-seed" };

const DRAFT: RoutineDraft = {
  instruction: "Send me yesterday's leads",
  title: "Leads",
  does: "act",
  starts: "unsaid",
  cron: null,
  timezone: "UTC",
  doneWhen: "",
  conversationId: null,
  intervalMinutes: null,
};

/** The router of the last `draw()`, to read where an action went. */
let router: {
  state: { location: { pathname: string; search: unknown; state: unknown } };
};

function draw(line: BoxLine, onDismiss: () => void = () => {}) {
  router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <BoxLineView line={line} bot={BOT} onDismiss={onDismiss} />
      ),
    }),
  });
  return render(<RouterProvider router={router as never} />);
}

const made = (open: MadeRoutine): BoxLine => ({
  kind: "made",
  botId: "bot-1",
  text: "Atlas will send you the leads every morning",
  open,
});

test("a routine that was made links to its page", async () => {
  const view = draw(made({ kind: "routine", id: "r1" }));
  const open = await view.findByRole("button", { name: "Open" });
  expect(open.getAttribute("href")).toBe("/routines/schedules/r1");
});

test("a goal that was made links to its page", async () => {
  const view = draw(made({ kind: "goal", id: "g1" }));
  const open = await view.findByRole("button", { name: "Open" });
  expect(open.getAttribute("href")).toBe("/routines/goals/g1");
});

test("a check-in that was made links to its page", async () => {
  const view = draw(made({ kind: "check-in", id: "ci1" }));
  const open = await view.findByRole("button", { name: "Open" });
  expect(open.getAttribute("href")).toBe("/routines/check-ins/ci1");
});

test("the Bot's name is drawn once, and the text is whole", async () => {
  const line = made({ kind: "routine", id: "r1" });
  const view = draw(line);
  const status = await view.findByRole("status");
  const text = status.querySelector("p") as HTMLParagraphElement;
  expect(text.textContent).toBe(line.text);
  expect(status.textContent?.match(/Atlas/g)).toHaveLength(1);
  expect(text.querySelector("span")?.textContent).toBe("Atlas");
});

test("Finish opens the form with the draft", async () => {
  const view = draw({
    kind: "finish",
    botId: "bot-1",
    text: "Atlas needs to know when for “Leads”",
    draft: DRAFT,
  });
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: "Finish" }));
  await settleReactWork();
  const { location } = router.state;
  expect(location.pathname).toBe("/routines/new");
  expect(location.search).toEqual({ agentId: "bot-1" });
  expect(
    (location.state as { routineDraft?: RoutineDraft }).routineDraft,
  ).toEqual(DRAFT);
});

test("Use the form opens the form with no draft when there is none", async () => {
  const view = draw({
    kind: "useForm",
    botId: "bot-1",
    text: "Couldn't read that as a routine.",
    draft: null,
  });
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: "Use the form" }));
  await settleReactWork();
  const { location } = router.state;
  expect(location.pathname).toBe("/routines/new");
  expect(location.search).toEqual({ agentId: "bot-1" });
  expect(
    (location.state as { routineDraft?: RoutineDraft }).routineDraft,
  ).toBeUndefined();
});

test("a refusal that needs an app offers Connect, in amber", async () => {
  const view = draw({
    kind: "refused",
    botId: "bot-1",
    text: "Gmail isn't connected.",
    fix: "connectApp",
  });
  const connect = await view.findByRole("button", { name: "Connect" });
  expect(connect.getAttribute("href")).toBe("/connections");
  const text = (await view.findByRole("status")).querySelector("p");
  expect(text?.className).toContain("text-warning");
});

test("a refusal with no fix and a maybe-made line are amber and offer nothing", async () => {
  for (const line of [
    {
      kind: "refused",
      botId: "bot-1",
      text: "That isn't something a routine can do.",
      fix: null,
    },
    { kind: "maybeMade", botId: "bot-1", text: "It may have been saved." },
  ] satisfies BoxLine[]) {
    const view = draw(line);
    const text = (await view.findByRole("status")).querySelector("p");
    expect(text?.className).toContain("text-warning");
    expect(
      view.queryByRole("button", {
        name: /^(Open|Finish|Use the form|Connect)$/,
      }),
    ).toBeNull();
    cleanup();
  }
});

test("Dismiss calls onDismiss once", async () => {
  let calls = 0;
  const view = draw(made({ kind: "routine", id: "r1" }), () => {
    calls += 1;
  });
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: "Dismiss" }));
  expect(calls).toBe(1);
});
