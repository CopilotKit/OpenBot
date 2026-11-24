import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { settleReactWork } from "./settle-react-work";

/**
 * A run on an AI connection that stopped working is refused by the server, and a refusal is drawn
 * under the message it refused (`refusals`). The conversation's notice about its connection
 * (`stoppedNotice`) goes under the latest refusal, once, and under `stopped` instead when that shows.
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

const REFUSED = "Claude stopped working: its sign-in ended.";

const messages: Message[] = [
  { id: "u1", role: "user", content: "First question." },
  { id: "u2", role: "user", content: "Second question." },
];

function wrap(children: ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

const notice = <p data-testid="connection-notice">Reconnect</p>;

test("the notice goes under the latest refusal, and under no other", () => {
  const view = render(
    wrap(
      <ChatTranscript
        messages={messages}
        refusals={
          new Map([
            ["u1", REFUSED],
            ["u2", REFUSED],
          ])
        }
        restoring={false}
        stoppedNotice={notice}
      />,
    ),
  );

  const rows = view.getAllByTestId("transcript-stopped");
  expect(rows).toHaveLength(2);
  const notices = view.getAllByTestId("connection-notice");
  expect(notices).toHaveLength(1);
  // After the second refusal's row, not the first's.
  const [first, second] = rows as [HTMLElement, HTMLElement];
  const [shown] = notices as [HTMLElement];
  expect(
    first.compareDocumentPosition(shown) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    second.compareDocumentPosition(shown) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("with `stopped` showing, the notice goes under it, not under a refusal", () => {
  const view = render(
    wrap(
      <ChatTranscript
        messages={messages}
        refusals={new Map([["u1", REFUSED]])}
        restoring={false}
        stopped="OpenBot couldn't reach the Bot."
        stoppedNotice={notice}
      />,
    ),
  );

  expect(view.getAllByTestId("connection-notice")).toHaveLength(1);
  const rows = view.getAllByTestId("transcript-stopped");
  const stopped = rows.find((row) =>
    row.textContent?.includes("couldn't reach"),
  ) as HTMLElement;
  const refused = rows.find((row) =>
    row.textContent?.includes(REFUSED),
  ) as HTMLElement;
  // The notice sits beside the `stopped` row, in its wrapper; the refusal's has none.
  expect(stopped.parentElement?.textContent).toContain("Reconnect");
  expect(refused.parentElement?.textContent).not.toContain("Reconnect");
});
