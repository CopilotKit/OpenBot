import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  ADD_MODEL_KEY_PATH,
  AddModelKeyLink,
  NO_AI_CONNECTION,
} from "@/components/channels/add-model-key-link";
import {
  getGetPersonMockHandler,
  getGetPersonResponseMock,
} from "@/lib/api/generated/people/people.msw";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot with no model key: the turn ends on the server's sentence that the organization has no AI
 * connection yet. FOUND ON OPENBOT CLOUD, where every organization brings its own key, so this is
 * what a new organization's first message ends on. An admin gets the way to add the key beside the
 * sentence; a member reads it, and it tells them to ask an admin. Read through the client generated
 * from api/openapi.yaml and answered by the spec's own mock handler.
 */

const server = setupServer(
  http.all("*", () => new HttpResponse(null, { status: 404 })),
);

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
  server.listen({ onUnhandledRequest: "error" });
  setCurrentOrganization("default");
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  server.resetHandlers();
});
afterAll(async () => {
  server.close();
  await settleReactWork();
  setCurrentOrganization(undefined);
  GlobalRegistrator.unregister();
});

function signedInAs(role: "owner" | "admin" | "member") {
  const answer = getGetPersonResponseMock();
  server.use(
    getGetPersonMockHandler({ ...answer, person: { ...answer.person, role } }),
  );
}

test("an admin reads that there is no AI connection and gets the way to add a model key", async () => {
  for (const role of ["admin", "owner"] as const) {
    signedInAs(role);
    const view = render(<AddModelKeyLink reason={NO_AI_CONNECTION} />);
    const link = await waitFor(() =>
      view.getByRole("link", { name: "Add a model key" }),
    );
    expect(link.getAttribute("href")).toBe(ADD_MODEL_KEY_PATH);
    cleanup();
    queryClient.clear();
  }
});

test("a member gets the sentence alone, with nothing to click", async () => {
  signedInAs("member");
  const view = render(<AddModelKeyLink reason={NO_AI_CONNECTION} />);
  await settleReactWork();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(view.queryByRole("link")).toBeNull();
});

test("any other reason a turn ended draws nothing and asks the server nothing", async () => {
  const view = render(
    <AddModelKeyLink reason="The Bot stopped without saying why." />,
  );
  await settleReactWork();
  expect(view.queryByRole("link")).toBeNull();
});
