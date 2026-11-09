import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { BotLookProvider } from "@/components/agents/bot-look";
import { ChannelAvatar } from "@/components/channels/avatar";
import { AuditPage } from "@/components/manage/audit-page";
import { useBotNames } from "@/lib/agents/bot-names";
import { agentKeys } from "@/lib/agents/queries";
import { seedAuditPage } from "./seed-audit-page";
import { settleReactWork } from "./settle-react-work";

/*
 * A person reads a Bot by its name, everywhere: the text, the tooltip on hover, and the label a
 * screen reader says. Found on Windows, where hovering a Bot in Activity showed "picked-harness" and
 * the Bot's avatar in a conversation was labelled with the same id.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

const ID = "picked-harness";
const NAME = "Personal Assistant";

function clientWith(
  shown: { id: string; name: string; avatarSeed?: string }[],
  hidden: { id: string; name: string }[] = [],
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(agentKeys.list(false), shown);
  queryClient.setQueryData(agentKeys.list(true), hidden);
  return queryClient;
}

/** Every attribute and every text node, so an id in a `title` or `aria-label` is found too. */
function everythingOn(root: Element): string {
  const parts = [root.textContent ?? ""];
  for (const element of [root, ...root.querySelectorAll("*")])
    for (const attribute of element.attributes)
      if (!attribute.name.startsWith("data-")) parts.push(attribute.value);
  return parts.join("\n");
}

async function renderActivity(queryClient: QueryClient) {
  seedAuditPage(queryClient, "", {
    events: [
      {
        id: "e1",
        actorUserId: null,
        initiatorKind: "person",
        initiatorId: null,
        eventType: "computer.action_allowed",
        targetType: "computer",
        targetId: ID,
        payload: { bot: ID, action: "computer_write_file", file: "a.txt" },
        createdAt: "2026-11-07T11:29:41Z",
      },
      {
        id: "e2",
        actorUserId: null,
        initiatorKind: "handoff",
        initiatorId: ID,
        eventType: "computer.action_allowed",
        targetType: "computer",
        targetId: "scout",
        payload: { bot: "scout", action: "computer_read_file", file: "b.txt" },
        createdAt: "2026-11-07T11:30:27Z",
      },
    ],
  });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <AuditPage /> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await view.findByText("Decision");
  return view;
}

test("Activity names the Bot and never shows its id, not even on hover", async () => {
  const view = await renderActivity(
    clientWith([
      { id: ID, name: NAME },
      { id: "scout", name: "Scout" },
    ]),
  );
  const table = view.container.querySelector("tbody") as Element;
  expect(table.textContent).toContain(NAME);
  expect(table.textContent).toContain(`Handed on by ${NAME}`);
  expect(everythingOn(table)).not.toContain(ID);
});

test("a Bot hidden from the sidebar is still named, and a deleted one is not its id", () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider
      client={clientWith(
        [{ id: "scout", name: "Scout" }],
        [{ id: ID, name: NAME }],
      )}
    >
      {children}
    </QueryClientProvider>
  );
  const { result } = renderHook(() => useBotNames(), { wrapper });
  expect(result.current(ID)).toBe(NAME);
  expect(result.current("deleted-bot")).toBe("A Bot no longer here");
});

test("before the Bots load, a Bot is named nothing rather than its id", () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useBotNames(), { wrapper });
  expect(result.current(ID)).toBe("");
});

test("a conversation's avatar is labelled with the Bot's name, not its id", () => {
  const view = render(
    <QueryClientProvider
      client={clientWith([{ id: ID, name: NAME, avatarSeed: "seed" }])}
    >
      <BotLookProvider value="orb">
        <ChannelAvatar participantIds={[ID]} size={24} />
      </BotLookProvider>
    </QueryClientProvider>,
  );
  expect(everythingOn(view.container)).not.toContain(ID);
  expect(
    view.container.querySelector("[role=img]")?.getAttribute("aria-label"),
  ).toBe(NAME);
});
