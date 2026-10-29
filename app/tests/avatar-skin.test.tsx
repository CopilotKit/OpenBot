import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { ChannelAvatar } from "@/components/channels/avatar";
import { DEFAULT_SKIN, setSkin } from "@/skins/store";
import { settleReactWork } from "./settle-react-work";

/*
 * Bots appear as their orb only in OpenBot's own look. A skin keeps the faces it was designed
 * with, so OpenDuet, OpenDots and OpenMuse draw exactly what they drew before.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  act(() => setSkin(DEFAULT_SKIN));
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

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
  test("is an orb in the default skin", () => {
    const view = render(<Avatar />);
    expect(view.container.querySelector("[data-variant]")).not.toBeNull();
    expect(view.container.querySelector("svg")).toBeNull();
  });

  test("keeps its face while a skin is active", () => {
    act(() => setSkin("openduet"));
    const view = render(<Avatar />);
    expect(view.container.querySelector("svg")).not.toBeNull();
    expect(view.container.querySelector("[data-variant]")).toBeNull();
  });
});

test("a group in the default skin shows two orbs", () => {
  const view = render(
    <ChannelAvatar
      participantIds={["knowledge", "risk-analyst", "release-notes"]}
      size={32}
    />,
  );
  expect(view.container.querySelectorAll("[data-variant]")).toHaveLength(2);
});

test("a busy conversation keeps its working badge as an orb", () => {
  const view = render(
    <ChannelAvatar participantIds={["knowledge"]} size={32} typing />,
  );
  expect(view.getByText("Working…")).toBeTruthy();
});
