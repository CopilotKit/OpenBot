import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import {
  ChatTranscript,
  skillLabels,
} from "@/components/channels/chat-transcript";
import { settleReactWork } from "./settle-react-work";

/**
 * A message that ran a skill is sent as `/command …`, and drawn with a badge naming the skill, as the
 * `/` menu and the composer's chip named it. Harness as in `transcript-open.test.tsx`.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function user(id: string, text: string): Message {
  return { id, role: "user", content: text };
}

const labels = skillLabels([{ id: "standup", name: "Standup notes" }]);

test("a skill's badge shows its name, not its command", () => {
  const view = render(
    <ChatTranscript
      commandLabels={labels}
      messages={[user("u1", "/standup for the design team")]}
      restoring={false}
    />,
  );
  expect(view.getByText("Standup notes")).toBeTruthy();
  expect(view.container.textContent).not.toContain("/standup");
  expect(view.container.textContent).toContain("for the design team");
});

test("a leading slash that is no skill stays as typed", () => {
  const view = render(
    <ChatTranscript
      commandLabels={labels}
      messages={[user("u1", "/etc/hosts is broken")]}
      restoring={false}
    />,
  );
  expect(view.getByText("/etc/hosts is broken")).toBeTruthy();
});
