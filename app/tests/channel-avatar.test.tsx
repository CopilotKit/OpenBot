import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ChannelAvatar } from "@/components/channels/avatar";
import { settleReactWork } from "./settle-react-work";

/*
 * A conversation's face in the sidebar. While the conversation is busy its Bot's orb works, and a
 * still dot says so as well: an orb this small only blinks, and with reduced motion it does not move
 * at all, so the orb alone would not read as busy from across the roster.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** The state each orb in the avatar is drawn in, back to front. */
function orbStates(container: HTMLElement) {
  return [...container.querySelectorAll("[data-state]")].map((orb) =>
    orb.getAttribute("data-state"),
  );
}

test("a busy conversation's orb works, and a still dot says it is working", () => {
  const view = render(<ChannelAvatar participantIds={["expenses"]} typing />);

  expect(orbStates(view.container)).toEqual(["thinking"]);
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

  const group = render(
    <ChannelAvatar
      participantIds={["expenses", "travel", "legal"]}
      state="done"
      typing
    />,
  );
  expect(orbStates(group.container)).toEqual(["done", "done", "done"]);
  // The dot is about the conversation, so it stays whatever the faces show.
  expect(group.getByText("Working…")).toBeTruthy();
});
