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
import { cleanup, fireEvent, render } from "@testing-library/react";
import { BusinessLink } from "@/components/edition/business-link";
import { TeamFeaturesDialog } from "@/components/edition/team-features-dialog";
import { deploymentKeys } from "@/lib/deployment/queries";

/**
 * The home page's link to OpenBot for Business: personal edition only, and closing it lasts for
 * the session, so it is back the next time the app starts.
 */

// The dialog's booking calendar keeps its address but never fetches it: no test reaches Calendly.
beforeAll(() =>
  GlobalRegistrator.register({
    url: "http://localhost/",
    settings: { navigation: { disableChildFrameNavigation: true } },
  }),
);
beforeEach(() => sessionStorage.clear());
afterEach(cleanup);
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

function draw(edition: "personal" | "team") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: false,
    selfHostBanner: false,
    localEvaluation: false,
    edition,
    transcription: false,
    voice: false,
  });
  return render(
    <QueryClientProvider client={client}>
      <BusinessLink />
      <TeamFeaturesDialog />
    </QueryClientProvider>,
  );
}

/*
 * It opened the website in a new tab, away from the app and its calendar. It opens the OpenBot for
 * Business dialog, with the booking calendar in it, and leaves nothing to follow out of the app.
 */
test("the personal edition's Meet OpenBot for Business opens the dialog in the app, not the website", async () => {
  const view = draw("personal");
  expect(view.queryByRole("link", { name: /OpenBot for Business/ })).toBeNull();
  expect(view.queryByRole("dialog")).toBeNull();

  fireEvent.click(
    view.getByRole("button", { name: "Meet OpenBot for Business" }),
  );

  const dialog = await view.findByRole("dialog", {
    name: "OpenBot for Business",
  });
  expect(dialog.querySelector('iframe[title="Booking calendar"]')).toBeTruthy();
});

test("the team edition shows nothing", () => {
  const view = draw("team");
  expect(view.queryByText("Meet OpenBot for Business")).toBeNull();
});

test("closing it lasts for the session", () => {
  const first = draw("personal");
  fireEvent.click(first.getByRole("button", { name: "Close" }));
  expect(first.queryByText("Meet OpenBot for Business")).toBeNull();
  first.unmount();

  // Back on the home page in the same session: still closed.
  expect(draw("personal").queryByText("Meet OpenBot for Business")).toBeNull();
  cleanup();

  // A new session: back again.
  sessionStorage.clear();
  expect(draw("personal").getByText("Meet OpenBot for Business")).toBeTruthy();
});
