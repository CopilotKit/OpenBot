import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ChannelItemContent } from "@/components/app-sidebar/channel-item-content";
import { settleReactWork } from "./settle-react-work";

/*
 * A row's second line says the one thing most worth knowing: that the conversation waits on you,
 * that its Bot is working, or what it is about.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function row(state: { waiting?: boolean; busy?: boolean }) {
  return render(
    <ChannelItemContent
      emphasis="agent"
      lastMessageAt="5m"
      name="Knowledge"
      participantIds={["knowledge"]}
      title="Plan next week"
      {...state}
    />,
  );
}

test("a waiting row says so in place of its summary", () => {
  const { container } = row({ waiting: true });
  expect(container.textContent).toContain("Waiting for you");
  expect(container.textContent).not.toContain("Plan next week");
});

test("a waiting row says so even while its Bot is working", () => {
  const { container } = row({ waiting: true, busy: true });
  expect(container.textContent).toContain("Waiting for you");
});

test("a busy row shows the working dots and no summary", () => {
  const { container } = row({ busy: true });
  expect(container.textContent).not.toContain("Plan next week");
  expect(container.textContent).toContain("Working…");
  expect(container.textContent?.match(/Working…/g)?.length).toBe(1);
});

test("any other row shows its summary", () => {
  const { container } = row({});
  expect(container.textContent).toContain("Plan next week");
  expect(container.textContent).not.toContain("Waiting for you");
});
