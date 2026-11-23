import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DescribeGrants } from "@/components/manage/describe-grants";
import type { AppGrantPreview } from "@/lib/app-grants/queries";
import type { AppGrantTranslation } from "@/lib/app-grants/translate";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/*
 * One Bot's app page, "Describe what this Bot can do": once the model chooses the actions, the exact
 * actions it will allow are listed, labelled as what OpenBot checks every call against, above the
 * reading of them in words. The server is faked at the fetch boundary.
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

/** What a real model answered for Parallel Search: search and fetch, never feedback. */
const TRANSLATION: AppGrantTranslation = {
  actions: ["web_search", "web_fetch"],
  grants: ["parallel/web_search", "parallel/web_fetch"],
  otherApps: [],
  summary: "Searches the web and reads pages.",
  explanation:
    "The Bot can read web search results and fetch content from specific web URLs. It cannot report problems to the Parallel team.",
  check: { ok: true },
  warning: null,
};

const PREVIEW: AppGrantPreview = {
  check: { ok: true },
  warning: null,
  changes: {
    added: [
      {
        ref: "parallel/web_search",
        name: "web_search",
        effect: "read",
        destructive: false,
      },
      {
        ref: "parallel/web_fetch",
        name: "web_fetch",
        effect: "read",
        destructive: false,
      },
    ],
    removed: [],
  },
  report: null,
};

let translation: AppGrantTranslation = TRANSLATION;

beforeEach(() => {
  queryClient.clear();
  translation = TRANSLATION;
  global.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/grants/translate")) return Response.json(translation);
    if (path.endsWith("/grants/replay")) return Response.json(PREVIEW);
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
});

async function choose(text: string) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <DescribeGrants
        agentId="personal-assistant"
        appKey="parallel"
        appTitle="Parallel Search"
        botName="Personal Assistant"
        sharedNeeded={null}
      />
    </QueryClientProvider>,
  );
  await userEvent.type(
    view.getByLabelText("Describe what Personal Assistant can do"),
    text,
  );
  fireEvent.click(view.getByRole("button", { name: "Choose actions" }));
  await view.findByText("Actions Personal Assistant may use");
  return view;
}

const fieldOf = (element: HTMLElement) =>
  element.closest('[data-slot="field"]') as HTMLElement;

test("the chosen actions are listed exactly, labelled as what OpenBot checks every call against, above the reading", async () => {
  const view = await choose("Only searches the web and reads pages");
  await view.findByText("What this lets Personal Assistant do");

  const field = fieldOf(view.getByText("Actions Personal Assistant may use"));
  expect(field.textContent).toContain(
    "Your model chose these from your description. Once you save, Personal Assistant may use exactly these Parallel Search actions and no others. OpenBot checks every call against this list.",
  );
  expect(within(field).getByText("web_search")).toBeTruthy();
  expect(within(field).getByText("web_fetch")).toBeTruthy();

  const reading = view.getByText("What this lets Personal Assistant do");
  expect(
    field.compareDocumentPosition(reading) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("an action the app doesn't offer says why under its name", async () => {
  translation = {
    ...TRANSLATION,
    actions: ["web_search", "send_email"],
    grants: ["parallel/web_search"],
    explanation: null,
    check: {
      ok: false,
      error: "send_email is not a Parallel Search action",
      problems: [
        {
          action: "send_email",
          message: "Parallel Search has no action called send_email.",
        },
      ],
    },
  };
  const view = await choose("Searches and sends email");
  const field = fieldOf(view.getByText("Actions Personal Assistant may use"));
  expect(within(field).getByText("send_email")).toBeTruthy();
  expect(
    within(field).getByText("Parallel Search has no action called send_email."),
  ).toBeTruthy();
});
