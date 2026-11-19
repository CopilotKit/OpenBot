import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Triggers } from "@/components/responsibilities/triggers";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import type { ResponsibilityRecord } from "@/lib/responsibilities";
import { queryClient } from "@/query-client";
import { DEPLOYMENT_PATH } from "./admin-settings-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A goal's Add trigger dialog offers Slack only where Slack can start it.
 *
 * FOUND IN USE: the personal edition (OpenBot Desktop) has no Slack pairing, so a Slack trigger saved
 * there could never fire. The New routine page already left Slack out there; this dialog still
 * offered it.
 */

beforeAll(() => GlobalRegistrator.register());
const originalFetch = global.fetch;
afterEach(() => {
  cleanup();
  queryClient.clear();
  global.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function serving(edition: "team" | "personal") {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === DEPLOYMENT_PATH) return Response.json({ edition });
    if (url.split("?")[0]?.endsWith("/triggers"))
      return Response.json({ triggers: [], nextCursor: null });
    return Response.json({});
  }) as unknown as typeof fetch;
}

const goal = {
  id: "goal-1",
  botId: "bot-1",
  status: "active",
  title: "Watch Slack mentions",
} as unknown as ResponsibilityRecord;

test("Slack is a trigger kind in the team edition and not in the personal one", async () => {
  for (const edition of ["team", "personal"] as const) {
    serving(edition);
    const view = render(
      <QueryClientProvider client={queryClient}>
        <Triggers goal={goal} />
      </QueryClientProvider>,
    );
    const user = userEvent.setup({ document });
    // What this OpenBot is, as the dialog reads it, before the list is opened.
    await queryClient.fetchQuery(deploymentCapabilitiesQueryOptions());
    await user.click(await view.findByRole("button", { name: "Add trigger" }));
    await user.click(await view.findByLabelText("Trigger"));
    expect(await view.findByRole("option", { name: "GitHub" })).toBeTruthy();
    await waitFor(() =>
      expect(view.queryByRole("option", { name: "Slack" }) !== null).toBe(
        edition === "team",
      ),
    );
    view.unmount();
    queryClient.clear();
  }
});
