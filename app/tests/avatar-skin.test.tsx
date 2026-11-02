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
 * Bots appear as their orb where the active skin asks for it (`botLook: "orb"`). OpenBot's own look
 * does; a skin that has not opted in keeps the faces it was designed with.
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
  test("is an orb where Bots are orbs", () => {
    const view = renderAs("orb", <Avatar />);
    expect(view.container.querySelector("[data-variant]")).not.toBeNull();
    expect(view.container.querySelector("svg")).toBeNull();
  });

  test("is a face where they are not", () => {
    const view = renderAs("face", <Avatar />);
    expect(view.container.querySelector("svg")).not.toBeNull();
    expect(view.container.querySelector("[data-variant]")).toBeNull();
  });
});

test("OpenBot's own look opts in to orbs and the skins do not", () => {
  expect(SKINS.openbot.botLook).toBe("orb");
  for (const id of ["openduet", "opendots", "openmuse"] as const) {
    expect(SKINS[id].botLook ?? "face").toBe("face");
  }
});

test("a group shows two orbs", () => {
  const view = renderAs(
    "orb",
    <ChannelAvatar
      participantIds={["knowledge", "risk-analyst", "release-notes"]}
      size={32}
    />,
  );
  expect(view.container.querySelectorAll("[data-variant]")).toHaveLength(2);
});

test("a conversation's orb is drawn from the Bot's seed, as its own avatar is", () => {
  const color = (view: ReturnType<typeof render>) =>
    view.container
      .querySelector<HTMLElement>("[data-variant]")
      ?.style.getPropertyValue("--c1");
  const own = color(
    renderAs("orb", <AbstractAvatar name="Copy" seed="knowledge" size={32} />),
  );
  cleanup();
  const inSidebar = color(
    renderAs(
      "orb",
      <ChannelAvatar participantIds={["knowledge-copy"]} size={32} />,
    ),
  );
  expect(own).toBeTruthy();
  expect(inSidebar).toBe(own);
});

test("a busy conversation keeps its working badge as an orb", () => {
  const view = renderAs(
    "orb",
    <ChannelAvatar participantIds={["knowledge"]} size={32} typing />,
  );
  expect(view.getByText("Working…")).toBeTruthy();
});
