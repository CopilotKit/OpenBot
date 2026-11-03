import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render as renderTree } from "@testing-library/react";
import type { ReactNode } from "react";
import { BotLookProvider } from "@/components/agents/bot-look";
import { ChannelAvatar } from "@/components/channels/avatar";
import { settleReactWork } from "./settle-react-work";

/*
 * A conversation's face in the sidebar. While the conversation is busy its Bot's orb works, and a
 * still dot says so as well: with reduced motion the orb does not move at all, and a skin's faces
 * show no state, so the orb alone would not read as busy from across the roster.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** Drawn where Bots are orbs, as in the default look, with no Bots listed. */
function render(tree: ReactNode) {
  const client = new QueryClient();
  client.setQueryData(["agents", "list", { hidden: false }], []);
  return renderTree(
    <QueryClientProvider client={client}>
      <BotLookProvider value="orb">{tree}</BotLookProvider>
    </QueryClientProvider>,
  );
}

/** The state each orb in the avatar is drawn in, back to front. */
function orbStates(container: HTMLElement) {
  return [...container.querySelectorAll("[data-state]")].map((orb) =>
    orb.getAttribute("data-state"),
  );
}

test("a busy conversation's orb works, and a still dot says it is working", () => {
  const view = render(<ChannelAvatar participantIds={["expenses"]} typing />);

  expect(orbStates(view.container)).toEqual(["working"]);
  expect(view.getByText("Working…").className).toContain("sr-only");
  // Nothing in the indicator moves, with or without reduced motion.
  expect(view.container.querySelector("[class*='animate-']")).toBeNull();
});

test("a quiet conversation's orb rests and has no dot", () => {
  const view = render(<ChannelAvatar participantIds={["expenses"]} />);

  expect(orbStates(view.container)).toEqual(["idle"]);
  expect(view.queryByText("Working…")).toBeNull();
});

test("a state passed in reaches every face, a group's included", () => {
  const one = render(
    <ChannelAvatar participantIds={["expenses"]} state="listening" />,
  );
  expect(orbStates(one.container)).toEqual(["listening"]);
  one.unmount();

  // A group shows its first two Bots' orbs.
  const group = render(
    <ChannelAvatar
      participantIds={["expenses", "travel", "legal"]}
      state="done"
      typing
    />,
  );
  expect(orbStates(group.container)).toEqual(["done", "done"]);
  // The dot is about the conversation, so it stays whatever the faces show.
  expect(group.getByText("Working…")).toBeTruthy();
});

test("a conversation waiting on the person has a needs dot, ahead of busy, and says so", () => {
  const view = render(
    <ChannelAvatar needsYou participantIds={["expenses"]} typing />,
  );
  const said = view.getByText("Needs you");
  expect(said.className).toContain("sr-only");
  expect(said.parentElement?.className).toContain("bg-status-needs");
  // One dot, and it is the person's turn, not the Bot working.
  expect(view.queryByText("Working…")).toBeNull();
  expect(view.container.querySelectorAll(".rounded-full.ring-2")).toHaveLength(
    1,
  );
});
