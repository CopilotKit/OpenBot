import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import {
  getGetPersonMockHandler,
  getGetPersonResponseMock,
} from "@/lib/api/generated/people/people.msw";
import type { CatalogueConnection, ModelCatalogue } from "@/lib/models/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";
import { vendoredMarkFor } from "./vendored-marks";

mock.module("@/lib/marks", () => ({ markFor: vendoredMarkFor }));
const { StoppedConnectionNotice } = await import(
  "@/components/channels/stopped-connection-notice"
);
const { ModelPicker } = await import(
  "@/components/channels/composer/model-picker"
);

/*
 * A run refused because the AI connection it would use stopped working (plans/multiple-ai-
 * connections-spec.md, step 4). After the refusal the conversation reads its model choice again; its
 * `stopped` names the connection and why, and the notice says so with Reconnect for whoever can fix
 * it and Choose another model for everybody. The refusal's own words are never matched.
 */

const ORG = "/api/v2/organizations/default";
const CHANNEL = "conversation-a";
const SENTENCE = "Your Claude plan sign-in ended. Sign in again to use it.";

const SOL = { id: "gpt-6.2-sol", label: "GPT-6.2 Sol", vendor: "openai" };
const OPUS = { id: "claude-opus-5-5", label: "Claude Opus 5.5" };

function connection(
  overrides: Partial<CatalogueConnection> &
    Pick<CatalogueConnection, "id" | "provider">,
): CatalogueConnection {
  return {
    owner: "personal",
    login: "plan",
    source: "chatgpt",
    isDefault: false,
    ready: true,
    problem: null,
    default: SOL.id,
    models: [SOL],
    listed: true,
    ...overrides,
  };
}

function catalogueWith(owner: "personal" | "organization"): ModelCatalogue {
  return {
    provider: "openai",
    source: "chatgpt",
    exposure: "all",
    default: SOL.id,
    models: [SOL],
    choosable: true,
    connections: [
      connection({ id: "openai", provider: "openai", isDefault: true, owner }),
      connection({
        id: "anthropic",
        provider: "anthropic",
        source: "claude",
        owner,
        ready: false,
        problem: { code: "sign-in-ended", detail: SENTENCE },
        default: OPUS.id,
        models: [OPUS],
      }),
    ],
  };
}

const server = setupServer(
  http.all("*", () => new HttpResponse(null, { status: 404 })),
);
let choiceReads = 0;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
  server.listen({ onUnhandledRequest: "error" });
  setCurrentOrganization("default");
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  server.resetHandlers();
  choiceReads = 0;
});
afterAll(async () => {
  server.close();
  await settleReactWork();
  setCurrentOrganization(undefined);
  GlobalRegistrator.unregister();
});

function serve({
  owner,
  role,
  stopped,
}: {
  owner: "personal" | "organization";
  role: "admin" | "member";
  stopped: boolean;
}) {
  const person = getGetPersonResponseMock();
  server.use(
    getGetPersonMockHandler({ ...person, person: { ...person.person, role } }),
    http.get(`*${ORG}/model-catalogue`, () =>
      HttpResponse.json(catalogueWith(owner)),
    ),
    http.get(`*${ORG}/people/me/model-choices/${CHANNEL}`, () => {
      choiceReads += 1;
      return HttpResponse.json({
        model: OPUS.id,
        effort: null,
        connection: "anthropic",
        stopped: stopped
          ? {
              connection: "anthropic",
              problem: { code: "sign-in-ended", detail: SENTENCE },
            }
          : null,
      });
    }),
  );
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

test("a refused run with stopped set draws the sentence, Reconnect and Choose another model", async () => {
  serve({ owner: "personal", role: "member", stopped: true });
  let chose = 0;
  const view = render(
    <StoppedConnectionNotice
      channelId={CHANNEL}
      onChooseModel={() => {
        chose += 1;
      }}
    />,
    { wrapper },
  );
  await view.findByText(SENTENCE);
  expect(choiceReads).toBeGreaterThan(0);
  const reconnect = view.getByRole("link", { name: "Reconnect" });
  expect(reconnect.getAttribute("href")).toBe(
    "/settings/providers/anthropic?owner=personal",
  );
  await userEvent
    .setup({ document })
    .click(view.getByRole("button", { name: "Choose another model" }));
  expect(chose).toBe(1);
});

test("under a refusal that already says the sentence, it isn't said twice: only the ways on", async () => {
  serve({ owner: "personal", role: "member", stopped: true });
  const view = render(
    <StoppedConnectionNotice
      channelId={CHANNEL}
      onChooseModel={() => {}}
      said={[SENTENCE]}
    />,
    { wrapper },
  );
  await view.findByRole("link", { name: "Reconnect" });
  expect(view.queryByText(SENTENCE)).toBeNull();
  expect(
    view.getByRole("button", { name: "Choose another model" }),
  ).toBeTruthy();
});

test("a member on the organization's connection gets no Reconnect", async () => {
  serve({ owner: "organization", role: "member", stopped: true });
  const view = render(
    <StoppedConnectionNotice channelId={CHANNEL} onChooseModel={() => {}} />,
    { wrapper },
  );
  await view.findByText(SENTENCE);
  expect(view.queryByRole("link", { name: "Reconnect" })).toBeNull();
  expect(
    view.getByRole("button", { name: "Choose another model" }),
  ).toBeTruthy();
});

test("an admin on the organization's connection gets Reconnect to its page in Settings → AI providers", async () => {
  serve({ owner: "organization", role: "admin", stopped: true });
  const view = render(
    <StoppedConnectionNotice channelId={CHANNEL} onChooseModel={() => {}} />,
    { wrapper },
  );
  const reconnect = await view.findByRole("link", { name: "Reconnect" });
  expect(reconnect.getAttribute("href")).toBe("/settings/providers/anthropic");
});

const GOOGLE_RETIRED =
  "Google sign-in for Gemini has ended. Add a Gemini API key in Settings under AI providers to keep using Gemini.";

/*
 * A run refused on a Google sign-in OpenBot no longer offers: the server's words, and one press to
 * Google Gemini's API key on the same connection, never Reconnect to a sign-in that can't be made.
 */
test("a run on a retired Google sign-in says so, with Add a Gemini API key straight to its key", async () => {
  const person = getGetPersonResponseMock();
  server.use(
    getGetPersonMockHandler({
      ...person,
      person: { ...person.person, role: "member" },
    }),
    http.get(`*${ORG}/model-catalogue`, () =>
      HttpResponse.json({
        ...catalogueWith("personal"),
        connections: [
          connection({
            id: "google",
            provider: "google",
            login: "oauth",
            source: "google",
            isDefault: true,
            ready: false,
            problem: { code: "sign-in-retired", detail: GOOGLE_RETIRED },
          }),
        ],
      }),
    ),
    http.get(`*${ORG}/people/me/model-choices/${CHANNEL}`, () =>
      HttpResponse.json({
        model: null,
        effort: null,
        connection: null,
        stopped: {
          connection: "google",
          problem: { code: "sign-in-retired", detail: GOOGLE_RETIRED },
        },
      }),
    ),
  );
  const view = render(
    <StoppedConnectionNotice channelId={CHANNEL} onChooseModel={() => {}} />,
    { wrapper },
  );
  await view.findByText(GOOGLE_RETIRED);
  expect(view.queryByRole("link", { name: "Reconnect" })).toBeNull();
  const add = view.getByRole("link", { name: "Add a Gemini API key" });
  expect(add.getAttribute("href")).toBe(
    "/settings/providers/google/change?owner=personal",
  );
});

const RETIRED_SAYS =
  "OpenBot no longer offers this AI provider. Remove it and connect another AI.";
const RETIRED_SAYS_TO_A_MEMBER =
  "OpenBot no longer offers your organization's AI provider. An admin has to connect another one.";

/*
 * A run refused on a connection saved for a provider OpenBot no longer offers (problem
 * `provider-retired`, under an id this app doesn't know). Nothing reconnects it: the way on is its
 * page in Settings → AI providers, where it is removed and another AI connected.
 */
function serveRetired(
  owner: "personal" | "organization",
  role: "admin" | "member",
  detail: string,
) {
  const person = getGetPersonResponseMock();
  const problem = { code: "provider-retired", detail };
  server.use(
    getGetPersonMockHandler({ ...person, person: { ...person.person, role } }),
    http.get(`*${ORG}/model-catalogue`, () =>
      HttpResponse.json({
        ...catalogueWith(owner),
        connections: [
          connection({
            id: "retired-ai",
            provider: "retired-ai",
            login:
              owner === "organization" && role === "member" ? null : "endpoint",
            source: "gateway",
            owner,
            isDefault: true,
            ready: false,
            problem,
            default: "",
            models: [],
            listed: false,
          }),
          connection({ id: "openai", provider: "openai", owner }),
        ],
      }),
    ),
    http.get(`*${ORG}/people/me/model-choices/${CHANNEL}`, () =>
      HttpResponse.json({
        model: null,
        effort: null,
        connection: null,
        stopped: { connection: "retired-ai", problem },
      }),
    ),
  );
}

test("a run on a provider OpenBot no longer offers says so, with Remove it to its page and never Reconnect", async () => {
  serveRetired("personal", "member", RETIRED_SAYS);
  let chose = 0;
  const view = render(
    <StoppedConnectionNotice
      channelId={CHANNEL}
      onChooseModel={() => {
        chose += 1;
      }}
    />,
    { wrapper },
  );
  await view.findByText(RETIRED_SAYS);
  expect(view.queryByRole("link", { name: "Reconnect" })).toBeNull();
  const remove = view.getByRole("link", { name: "Remove it" });
  expect(remove.getAttribute("href")).toBe(
    "/settings/providers/retired-ai?owner=personal",
  );
  await userEvent
    .setup({ document })
    .click(view.getByRole("button", { name: "Choose another model" }));
  expect(chose).toBe(1);
});

test("the organization's retired provider: an admin gets Remove it, a member reads that an admin has to", async () => {
  serveRetired("organization", "admin", RETIRED_SAYS);
  const admin = render(
    <StoppedConnectionNotice channelId={CHANNEL} onChooseModel={() => {}} />,
    { wrapper },
  );
  const remove = await admin.findByRole("link", { name: "Remove it" });
  expect(remove.getAttribute("href")).toBe("/settings/providers/retired-ai");
  cleanup();
  queryClient.clear();
  server.resetHandlers();

  serveRetired("organization", "member", RETIRED_SAYS_TO_A_MEMBER);
  const member = render(
    <StoppedConnectionNotice channelId={CHANNEL} onChooseModel={() => {}} />,
    { wrapper },
  );
  await member.findByText(RETIRED_SAYS_TO_A_MEMBER);
  expect(member.queryByRole("link")).toBeNull();
  expect(
    member.getByRole("button", { name: "Choose another model" }),
  ).toBeTruthy();
});

test("a refused run with stopped null draws nothing here", async () => {
  serve({ owner: "personal", role: "member", stopped: false });
  const view = render(
    <StoppedConnectionNotice channelId={CHANNEL} onChooseModel={() => {}} />,
    { wrapper },
  );
  await waitFor(() => expect(choiceReads).toBeGreaterThan(0));
  expect(view.container.textContent).toBe("");
});

test("the trigger shows the warning mark while stopped is set, and none after the choice changes", () => {
  const catalogue = catalogueWith("personal");
  const pick = { model: SOL.id, effort: null, connection: "openai" };
  const view = render(
    <ModelPicker
      catalogue={catalogue}
      onChange={() => {}}
      stopped
      value={pick}
    />,
  );
  const trigger = view.getByRole("combobox", { name: /GPT-6.2 Sol/ });
  expect(trigger.getAttribute("aria-label")).toContain("can't run now");
  expect(
    trigger.querySelector("svg.tabler-icon-alert-triangle"),
  ).not.toBeNull();
  view.rerender(
    <ModelPicker catalogue={catalogue} onChange={() => {}} value={pick} />,
  );
  const after = view.getByRole("combobox", { name: /GPT-6.2 Sol/ });
  expect(after.getAttribute("aria-label")).not.toContain("can't run now");
  expect(after.querySelector("svg.tabler-icon-alert-triangle")).toBeNull();
});

const NO_DEFAULT = "Choose a default AI in Settings so Bots can start work.";

function serveNoDefault(
  role: "admin" | "member",
  owner: "personal" | "organization",
) {
  const person = getGetPersonResponseMock();
  server.use(
    getGetPersonMockHandler({ ...person, person: { ...person.person, role } }),
    http.get(`*${ORG}/model-catalogue`, () =>
      HttpResponse.json(catalogueWith(owner)),
    ),
    http.get(`*${ORG}/people/me/model-choices/${CHANNEL}`, () => {
      choiceReads += 1;
      return HttpResponse.json({
        model: null,
        effort: null,
        connection: null,
        stopped: {
          connection: null,
          problem: { code: "no-default", detail: NO_DEFAULT },
        },
      });
    }),
  );
}

test("no default: it says to choose one, with Choose a default into Settings for whoever can fix it", async () => {
  serveNoDefault("member", "personal");
  const view = render(
    <StoppedConnectionNotice channelId={CHANNEL} onChooseModel={() => {}} />,
    { wrapper },
  );
  await view.findByText(NO_DEFAULT);
  const link = view.getByRole("link", { name: "Choose a default" });
  expect(link.getAttribute("href")).toBe("/settings/providers");
  expect(view.queryByRole("link", { name: "Reconnect" })).toBeNull();
  expect(
    view.getByRole("button", { name: "Choose another model" }),
  ).toBeTruthy();
});

test("no default on the organization's connections: a member reads it and gets no link", async () => {
  serveNoDefault("member", "organization");
  const view = render(
    <StoppedConnectionNotice channelId={CHANNEL} onChooseModel={() => {}} />,
    { wrapper },
  );
  await view.findByText(NO_DEFAULT);
  expect(view.queryByRole("link")).toBeNull();
});
