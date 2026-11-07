import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider, useFrontendTool } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { GALLERY as ACTIVITY } from "@/components/gallery/activity";
import { GALLERY as CARDS } from "@/components/gallery/cards";
import { GALLERY as CHARTS } from "@/components/gallery/charts";
import { GALLERY as DECISIONS } from "@/components/gallery/decisions";
import { GALLERY as FORMS } from "@/components/gallery/form";
import { GALLERY as QUOTES } from "@/components/gallery/quote";
import { GALLERY as TABLES } from "@/components/gallery/table";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import {
  makeDecisionRender,
  makeGalleryRender,
} from "@/lib/copilot/gallery-tools";
import { createGrantStore, type GrantStore } from "@/lib/copilot/grant-store";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * A gallery call that is over and left nothing to draw says so, instead of waiting for good.
 *
 * Seen on Windows with a Claude Agent SDK Bot: it called the table with its `columns` array missing
 * both brackets. Claude Code refused the arguments before the browser saw the call, the call ended
 * with that error as its result, and the card said "Waiting for complete table data…" for good, and
 * again when the conversation was reopened. Every component is drawn here by the real transcript,
 * through the renderers the app registers, from the call as it streamed (`live`) and as a reloaded
 * conversation has it (`reloaded`).
 */

const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // Nothing here needs the server.
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

/** The table call from the Windows run: `columns` lost both of its brackets. */
const BROKEN =
  '{"title":"Weekend picks in Chicago","caption":"Saturday Nov 7 to Sunday Nov 8","columns":"Event","When","Where","Source"],"rows":[{"cells":["Marathon expo","Sat 10am","McCormick Place","chicagomarathon.com"]}]}';

/** Claude Code refusing those arguments, as the harness streams it and keeps it in the history. */
const CLAUDE_CODE_REFUSED = JSON.stringify({
  error: true,
  content:
    "<tool_use_error>InputValidationError: mcp__ag_ui__showTable was called with input that could not be parsed as JSON</tool_use_error>",
});

/** CopilotKit's own answer to a call whose arguments it couldn't parse (`executeToolHandler`). */
const BROWSER_REFUSED = `Error: Unexpected token ',', ..."s":"Event","When","... is not valid JSON`;

const UNREADABLE =
  "The Bot sent data OpenBot couldn't read. Ask it to try again.";

const SHOWN: GalleryComponent[] = [
  ...TABLES,
  ...ACTIVITY,
  ...CARDS,
  ...CHARTS,
  ...QUOTES,
];
const ASKED: GalleryComponent[] = [...DECISIONS, ...FORMS];
const ALL = [...SHOWN, ...ASKED];

function spec(name: string): GalleryComponent {
  const found = ALL.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`${name} is not in the gallery.`);
  return found;
}

/** One component registered as the app registers it, with the Bot holding all of them. */
function Registered({
  component,
  store,
}: {
  component: GalleryComponent;
  store: GrantStore;
}) {
  const [render] = useState(() =>
    component.kind === "decision"
      ? makeDecisionRender(component, store, async () => {})
      : makeGalleryRender(component, store),
  );
  useFrontendTool({
    name: component.name,
    parameters: component.parameters,
    handler: async () => component.confirmation ?? "",
    render,
    ...(component.kind === "decision"
      ? { type: "human-in-the-loop" as const }
      : {}),
  } as Parameters<typeof useFrontendTool>[0]);
  return null;
}

/** A turn of one call, answered with `result`, or still without one. */
function turn(name: string, args: string, result?: string): Message[] {
  return [
    {
      id: "u1",
      role: "user",
      content: "Find three things to do this weekend.",
    },
    {
      id: "a1",
      role: "assistant",
      content: "Here are three solid picks with dates and sources:",
      toolCalls: [
        { id: "call-1", type: "function", function: { name, arguments: args } },
      ],
    },
    ...(result === undefined
      ? []
      : [
          {
            id: "t1",
            role: "tool" as const,
            toolCallId: "call-1",
            content: result,
          },
        ]),
  ];
}

function draw(messages: Message[], busy = false) {
  const store = createGrantStore();
  store.set({
    grants: {
      status: "known",
      held: new Map(ALL.map((entry) => [entry.name, entry.description])),
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        {ALL.map((component) => (
          <Registered
            component={component}
            key={component.name}
            store={store}
          />
        ))}
        <ChatTranscript busy={busy} messages={messages} restoring={false} />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

const failure = (title: string) => `Couldn't show the ${title.toLowerCase()}.`;

for (const component of ALL) {
  for (const [moment, busy] of [
    ["as it streamed", true],
    ["after a reload", false],
  ] as const) {
    test(`${component.title}: refused arguments show a failure ${moment}`, async () => {
      const view = draw(
        turn(component.name, BROKEN, CLAUDE_CODE_REFUSED),
        busy,
      );

      expect(await view.findByText(failure(component.title))).toBeTruthy();
      expect(view.getByText(UNREADABLE)).toBeTruthy();
      expect(view.queryByText(/Waiting for complete table data/)).toBeNull();
      expect(view.queryByText(/Choosing a report/)).toBeNull();
    });
  }

  test(`${component.title}: arguments the browser couldn't parse show a failure`, async () => {
    const view = draw(turn(component.name, BROKEN, BROWSER_REFUSED));

    expect(await view.findByText(failure(component.title))).toBeTruthy();
    expect(view.getByText(UNREADABLE)).toBeTruthy();
  });
}

/*
 * The two that held a placeholder until their data was whole: still waiting while the call streams,
 * and a failure once its arguments are final, whatever the result says.
 */
for (const [name, waiting] of [
  ["showTable", /Waiting for complete table data/],
  ["showActivityReport", /Choosing a report/],
] as const) {
  const { title } = spec(name);

  test(`${title}: a call still streaming keeps waiting`, async () => {
    const view = draw(turn(name, '{"title":"Weekend picks in Chi'), true);

    expect(await view.findByText(waiting)).toBeTruthy();
    expect(view.queryByText(failure(title))).toBeNull();
  });

  test(`${title}: unusable arguments that were answered show a failure`, async () => {
    const view = draw(turn(name, BROKEN, spec(name).confirmation));

    expect(await view.findByText(failure(title))).toBeTruthy();
    expect(view.queryByText(waiting)).toBeNull();
  });

  test(`${title}: a call left without data when its turn ended shows a failure`, async () => {
    const view = draw(turn(name, '{"title":"Weekend picks in Chi'), false);

    expect(await view.findByText(failure(title))).toBeTruthy();
    expect(view.queryByText(waiting)).toBeNull();
  });
}

test("a table whose call failed after it was sent whole says it went wrong", async () => {
  const table = JSON.stringify(TABLES[0]?.preview);
  const view = draw(turn("showTable", table, CLAUDE_CODE_REFUSED));

  expect(await view.findByText(failure("Data table"))).toBeTruthy();
  expect(
    view.getByText(
      "Something went wrong while showing it. Ask the Bot to try again.",
    ),
  ).toBeTruthy();
  // The table the Bot was told failed is not drawn as if it worked.
  expect(view.queryByRole("table")).toBeNull();
});

test("a table that worked still draws", async () => {
  const table = JSON.stringify(TABLES[0]?.preview);
  const view = draw(turn("showTable", table, spec("showTable").confirmation));

  expect(await view.findByRole("table")).toBeTruthy();
  expect(view.queryByText(failure("Data table"))).toBeNull();
});

test("a decision stopped while it waited keeps the question it asked", async () => {
  const asked = JSON.stringify({
    title: "Refund this order?",
    summary: "The customer was charged twice.",
  });
  const view = draw(
    turn("askApproval", asked, "Error: Human-in-the-loop interaction aborted"),
  );

  expect(await view.findByText("Refund this order?")).toBeTruthy();
  expect(view.queryByText(failure("Approval"))).toBeNull();
});

test("a failure has the card's frame, not a refusal's", async () => {
  const view = draw(turn("showTable", BROKEN, CLAUDE_CODE_REFUSED));
  const lead = await view.findByText(failure("Data table"));

  expect(lead.closest('[data-slot="gallery-frame"]')?.tagName).toBe("FIGURE");
  expect(lead.closest('[role="status"]')).toBeTruthy();
  expect(view.queryByTestId("component-refused")).toBeNull();
});
