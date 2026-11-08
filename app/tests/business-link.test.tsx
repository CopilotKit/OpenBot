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
import { deploymentKeys } from "@/lib/deployment/queries";

/**
 * The home page's link to OpenBot for Business: personal edition only, and closing it lasts for
 * the session, so it is back the next time the app starts.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
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
    </QueryClientProvider>,
  );
}

test("the personal edition links to OpenBot for Business in a new tab", () => {
  const view = draw("personal");
  const link = view.getByRole("link", { name: "Meet OpenBot for Business" });
  expect(link.getAttribute("href")).toBe("https://open.bot/business");
  expect(link.getAttribute("target")).toBe("_blank");
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
