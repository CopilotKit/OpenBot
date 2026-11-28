// app/tests/account-mode-dialog.test.tsx
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountModeDialog } from "../src/components/plugins/account-mode-dialog";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
const sent: { body: unknown }[] = [];
let failing = false;
beforeEach(() => {
  sent.length = 0;
  failing = false;
  global.fetch = Object.assign(
    async (_path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      sent.push({ body });
      const bots = [
        {
          botId: "triage",
          approval: { audience: "team", outsideInput: true, members: [] },
        },
      ];
      if (body?.validateOnly === true) {
        return Response.json({
          mode: "shared",
          applied: false,
          accountsEnded: { holder: "person", count: 14 },
          bots,
        });
      }
      if (failing)
        return Response.json(
          {
            type: "https://open.bot/errors/app-service-failed",
            title: "The service behind this app didn't answer.",
            status: 502,
            detail: "Composio said no.",
            code: "APP_SERVICE_FAILED",
            category: "dependency",
            retryable: true,
            requestId: "req_test",
            traceId: "trace_test",
            problems: [{ account: "u2", detail: "Composio said no." }],
          },
          {
            status: 502,
            headers: { "content-type": "application/problem+json" },
          },
        );
      return Response.json({
        mode: "shared",
        applied: true,
        accountsEnded: { holder: "person", count: 14 },
        bots,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

function draw() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AccountModeDialog
        onOpenChange={() => {}}
        open
        serverId="linear"
        target="shared"
        title="Linear"
      />
    </QueryClientProvider>,
  );
}

describe("switching an app to Shared", () => {
  test("names what goes, warns, and lists each Bot's approval before anything changes", async () => {
    const view = draw();
    expect(
      await view.findByText("14 personal accounts will be disconnected."),
    ).toBeTruthy();
    expect(
      view.getByText(
        "Everyone using a Bot with this app will act as this one account.",
      ),
    ).toBeTruthy();
    expect(view.getByText(/triage/)).toBeTruthy();
    expect(view.getByText(/Everyone, and outside input/)).toBeTruthy();
    expect(sent).toEqual([{ body: { mode: "shared", validateOnly: true } }]);
  });

  test("confirming sends the switch once", async () => {
    const view = draw();
    await userEvent.click(
      await view.findByRole("button", { name: "Make Linear shared" }),
    );
    expect(sent.at(-1)).toEqual({ body: { mode: "shared" } });
  });

  test("a vendor that refuses a revoke is shown in the dialog, which stays open", async () => {
    failing = true;
    const view = draw();
    await userEvent.click(
      await view.findByRole("button", { name: "Make Linear shared" }),
    );
    expect(await view.findByText("Composio said no.")).toBeTruthy();
    expect(
      view.getByRole("button", { name: "Make Linear shared" }),
    ).toBeTruthy();
  });
});
