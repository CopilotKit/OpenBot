import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { ConversationView } from "@/components/channels/conversation-view";
import { GroupChat } from "@/components/channels/group-chat";
import { groupKeys } from "@/lib/groups";
import { appConfig } from "@/lib/generated/application-config";
import { settleReactWork } from "./settle-react-work";

/**
 * Every conversation says, under its composer, that its Bots are AI and can be wrong, in the name
 * this OpenBot is configured with. Small and muted, in the caption size.
 */

const originalFetch = globalThis.fetch;
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
beforeEach(() => {
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const notice = `${appConfig.brand.productName} is AI and can make mistakes.`;

/** The notice, checked to come after the conversation's composer. */
function under(container: HTMLElement) {
  const line = Array.from(container.querySelectorAll("p")).find(
    (paragraph) => paragraph.textContent === notice,
  );
  if (!line) throw new Error("no notice");
  const composer = container.querySelector('form[data-slot="composer"]');
  if (!composer) throw new Error("no composer");
  expect(
    composer.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(composer.contains(line)).toBe(false);
  return line;
}

test("a conversation with one Bot says so under its composer", () => {
  const view = render(
    <ConversationView channelId="c-1" messages={[]} onSubmit={() => {}} />,
  );
  const line = under(view.container);
  const column = view.container.querySelector('[data-slot="composer-column"]');
  expect(line.parentElement).toBe(column as HTMLElement);
  expect(line.className).toContain("type-caption");
  expect(line.className).toContain("text-muted-foreground");
});

test("a conversation with several Bots says so under its composer too", () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(groupKeys.detail("g-1"), {
    id: "g-1",
    title: "Launch",
    bots: [{ id: "inbox", name: "Inbox" }],
    messages: [],
  } as never);
  const view = render(
    <QueryClientProvider client={client}>
      <GroupChat channelId="g-1" />
    </QueryClientProvider>,
  );
  expect(under(view.container).className).toContain("type-caption");
});
