import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { TeamBotConsentCard } from "@/components/channels/team-bot-consent";
import { readTeamBotConsent } from "@/lib/team-bots";
import {
  noContent,
  problemResponse,
  type SentRequest,
  sentRequest,
  teamBotConsentPath,
} from "./bots-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A Team Bot somebody else published asks, in the conversation, to use one of the person's own
 * accounts. The card drawn from that refusal records the person's answer at the Team Bot's address
 * in the API, and says what it did.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

/** The tool result the server sends when a Team Bot needs the person's own Gmail. */
const REFUSAL =
  'Refused. [team-bot-consent]{"botId":"team/expenses","serverId":"gmail"} Use your own Gmail account with Expenses?';

function serving(answer: () => Response) {
  const writes: SentRequest[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    writes.push(sentRequest(input, init));
    return answer();
  }) as unknown as typeof fetch;
  return writes;
}

function draw() {
  const consent = readTeamBotConsent(REFUSAL.slice("Refused. ".length));
  if (!consent) throw new Error("The refusal carries no consent request.");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TeamBotConsentCard {...consent} />
    </QueryClientProvider>,
  );
}

test("Always allow for this Bot records the answer for that Team Bot and that app", async () => {
  const writes = serving(noContent);
  const view = draw();
  expect(
    view.getByText("Use your own Gmail account with Expenses?"),
  ).toBeTruthy();
  fireEvent.click(
    view.getByRole("button", { name: "Always allow for this Bot" }),
  );
  expect(
    await view.findByText("Always allowed for this Bot. Ask it to try again."),
  ).toBeTruthy();
  expect(writes).toEqual([
    {
      method: "POST",
      path: teamBotConsentPath("team/expenses"),
      key: expect.stringMatching(/^[0-9a-f]{32}$/),
      body: { serverId: "gmail", decision: "allow_always" },
    },
  ]);
});

test("an answer the server refused says why, and keeps the choices", async () => {
  serving(() => problemResponse(404, "That Bot isn't shared with you."));
  const view = draw();
  fireEvent.click(view.getByRole("button", { name: "Skip" }));
  expect((await view.findByRole("alert")).textContent).toBe(
    "That Bot isn't shared with you.",
  );
  expect(view.getByRole("button", { name: "Allow once" })).toBeTruthy();
});
