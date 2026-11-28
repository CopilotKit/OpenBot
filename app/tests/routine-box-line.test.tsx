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
 * The line under the Routines box says what the box did with a sentence and offers what fits beside
 * the words: open or undo what it made, finish it in the form, or connect the app it needs. No line
 * has a close button.
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

function draw(
  line: BoxLine,
  props: { onUndo?: () => void; undoing?: boolean } = {},
) {
  router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <BoxLineView
          line={line}
          bot={BOT}
          onUndo={props.onUndo ?? (() => {})}
          undoing={props.undoing}
        />
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
  const view = draw(
    made({
      kind: "routine",
      id: "r1",
      when: "Weekdays at 09:00",
      startedConversationId: null,
    }),
  );
  const open = await view.findByRole("button", { name: "Open" });
  expect(open.getAttribute("href")).toBe("/routines/schedules/r1");
});

test("a goal that was made links to its page", async () => {
  const view = draw(
    made({
      kind: "goal",
      id: "g1",
      when: "",
      routineId: null,
      startedConversationId: null,
    }),
  );
  const open = await view.findByRole("button", { name: "Open" });
  expect(open.getAttribute("href")).toBe("/routines/goals/g1");
});

test("a check-in that was made links to its page", async () => {
  const view = draw(
    made({
      kind: "check-in",
      id: "ci1",
      when: "Checks every hour",
      startedConversationId: null,
    }),
  );
  const open = await view.findByRole("button", { name: "Open" });
  expect(open.getAttribute("href")).toBe("/routines/check-ins/ci1");
});

test("the Bot's name is drawn once, and the text is whole", async () => {
  const line = made({
    kind: "routine",
    id: "r1",
    when: "Weekdays at 09:00",
    startedConversationId: null,
  });
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

test("a line that couldn't be read has no action", async () => {
  const view = draw({
    kind: "unread",
    botId: "bot-1",
    text: "Couldn't read that as a routine.",
  });
  expect(await view.findByRole("status")).toBeTruthy();
  expect(view.queryAllByRole("button")).toHaveLength(0);
});

test("a removed line says so and has no action", async () => {
  const view = draw({ kind: "removed", botId: "bot-1", text: "Removed." });
  const status = await view.findByRole("status");
  expect(status.textContent).toContain("Removed.");
  expect(view.queryAllByRole("button")).toHaveLength(0);
});

test("a made line offers Open and Undo", async () => {
  const view = draw(
    made({ kind: "routine", id: "r1", when: "", startedConversationId: null }),
  );
  await view.findByRole("button", { name: "Open" });
  const undo = await view.findByRole("button", { name: "Undo" });
  expect((undo as HTMLButtonElement).disabled).toBe(false);
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
        name: /^(Open|Undo|Finish|Connect)$/,
      }),
    ).toBeNull();
    cleanup();
  }
});

test("Undo calls onUndo once", async () => {
  let calls = 0;
  const view = draw(
    made({ kind: "routine", id: "r1", when: "", startedConversationId: null }),
    {
      onUndo: () => {
        calls += 1;
      },
    },
  );
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: "Undo" }));
  expect(calls).toBe(1);
});

test("Undo is disabled while it is working", async () => {
  let calls = 0;
  const view = draw(
    made({ kind: "routine", id: "r1", when: "", startedConversationId: null }),
    {
      onUndo: () => {
        calls += 1;
      },
      undoing: true,
    },
  );
  const undo = (await view.findByRole("button", {
    name: "Undo",
  })) as HTMLButtonElement;
  expect(undo.disabled).toBe(true);
  const user = userEvent.setup({ document });
  await user.click(undo);
  expect(calls).toBe(0);
});

test("no line has a Dismiss or a close button", async () => {
  const lines: BoxLine[] = [
    made({ kind: "routine", id: "r1", when: "", startedConversationId: null }),
    {
      kind: "finish",
      botId: "bot-1",
      text: "Atlas needs to know when",
      draft: DRAFT,
    },
    { kind: "refused", botId: "bot-1", text: "No.", fix: "connectApp" },
    { kind: "refused", botId: "bot-1", text: "No.", fix: null },
    { kind: "maybeMade", botId: "bot-1", text: "It may have been saved." },
    {
      kind: "unread",
      botId: "bot-1",
      text: "Couldn't read that as a routine.",
    },
    { kind: "removed", botId: "bot-1", text: "Removed." },
  ];
  for (const line of lines) {
    const view = draw(line);
    await view.findByRole("status");
    expect(view.queryByRole("button", { name: /dismiss|close/i })).toBeNull();
    expect(view.container.querySelector("svg.tabler-icon-x")).toBeNull();
    cleanup();
  }
});
