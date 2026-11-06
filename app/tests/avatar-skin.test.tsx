import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { type BotLook, BotLookProvider } from "@/components/agents/bot-look";
import { ChannelAvatar } from "@/components/channels/avatar";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { SKINS } from "@/skins/registry";
import { settleReactWork } from "./settle-react-work";

/*
 * Bots appear as their kite where the active skin asks for it (`botLook: "kite"`). OpenBot's own
 * look does; a skin that has not opted in keeps the faces it was designed with.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function renderAs(look: BotLook, avatar: ReactNode) {
  const queryClient = new QueryClient();
  // A duplicated Bot: a new id, the source's seed.
  queryClient.setQueryData(agentListQueryOptions().queryKey, [
    { id: "knowledge-copy", avatarSeed: "knowledge" },
  ] as never);
  return render(
    <QueryClientProvider client={queryClient}>
      <BotLookProvider value={look}>{avatar}</BotLookProvider>
    </QueryClientProvider>,
  );
}

const avatars = {
  "a Bot's avatar": () => (
    <AbstractAvatar name="Knowledge" seed="knowledge" size={32} />
  ),
  "a conversation's avatar": () => (
    <ChannelAvatar participantIds={["knowledge"]} size={32} />
  ),
  "a group conversation's avatar": () => (
    <ChannelAvatar participantIds={["knowledge", "risk-analyst"]} size={32} />
  ),
};

describe.each(Object.entries(avatars))("%s", (_, Avatar) => {
  test("is a kite where Bots are kites", () => {
    const view = renderAs("kite", <Avatar />);
    expect(view.container.querySelector("[data-kite]")).not.toBeNull();
    expect(view.container.querySelector("svg")).toBeNull();
  });

  test("is a face where they are not", () => {
    const view = renderAs("face", <Avatar />);
    expect(view.container.querySelector("svg")).not.toBeNull();
    expect(view.container.querySelector("[data-kite]")).toBeNull();
  });
});

test("OpenBot's own look opts in to kites and the skins do not", () => {
  expect(SKINS.openbot.botLook).toBe("kite");
  for (const id of ["openduet", "opendots", "openmuse"] as const) {
    expect(SKINS[id].botLook ?? "face").toBe("face");
  }
});

test("a group shows two kites", () => {
  const view = renderAs(
    "kite",
    <ChannelAvatar
      participantIds={["knowledge", "risk-analyst", "release-notes"]}
      size={32}
    />,
  );
  expect(view.container.querySelectorAll("[data-kite]")).toHaveLength(2);
});

test("a conversation's kite is drawn from the Bot's seed, as its own avatar is", () => {
  const livery = (view: ReturnType<typeof render>) => {
    const kite = view.container.querySelector<HTMLElement>("[data-kite]");
    return `${kite?.dataset.slot} ${kite?.dataset.pattern}`;
  };
  const own = livery(
    renderAs("kite", <AbstractAvatar name="Copy" seed="knowledge" size={32} />),
  );
  cleanup();
  const inSidebar = livery(
    renderAs(
      "kite",
      <ChannelAvatar participantIds={["knowledge-copy"]} size={32} />,
    ),
  );
  expect(own).not.toBe("undefined undefined");
  expect(inSidebar).toBe(own);
});

test("a busy conversation's kite works, and says so", () => {
  const view = renderAs(
    "kite",
    <ChannelAvatar participantIds={["knowledge"]} size={32} typing />,
  );
  expect(
    view.container.querySelector<HTMLElement>("[data-kite]")?.dataset.state,
  ).toBe("thinking");
  expect(view.getByText("Working…")).toBeTruthy();
});

test("a busy group keeps its working badge, since no one kite is the one working", () => {
  const view = renderAs(
    "kite",
    <ChannelAvatar
      participantIds={["knowledge", "risk-analyst"]}
      size={32}
      typing
    />,
  );
  for (const kite of view.container.querySelectorAll<HTMLElement>(
    "[data-kite]",
  ))
    expect(kite.dataset.state).toBe("idle");
  expect(view.getByText("Working…")).toBeTruthy();
});

test("a Bot's avatar shows the state it is given", () => {
  const view = renderAs(
    "kite",
    <AbstractAvatar
      name="Knowledge"
      seed="knowledge"
      size={28}
      state="sleeping"
    />,
  );
  expect(view.getByRole("img", { name: "Knowledge" }).dataset.state).toBe(
    "sleeping",
  );
});
