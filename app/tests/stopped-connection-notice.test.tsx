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
    "/settings?connection=anthropic&owner=personal",
  );
  await userEvent
    .setup({ document })
    .click(view.getByRole("button", { name: "Choose another model" }));
  expect(chose).toBe(1);
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

test("an admin on the organization's connection gets Reconnect to /settings?connection=<id>", async () => {
  serve({ owner: "organization", role: "admin", stopped: true });
  const view = render(
    <StoppedConnectionNotice channelId={CHANNEL} onChooseModel={() => {}} />,
    { wrapper },
  );
  const reconnect = await view.findByRole("link", { name: "Reconnect" });
  expect(reconnect.getAttribute("href")).toBe(
    "/settings?connection=anthropic&owner=organization",
  );
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
