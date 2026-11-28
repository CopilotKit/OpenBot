import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { SignInForm } from "@/components/passwords/sign-in-form";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * The private sign-in form lets the person's own password manager fill it.
 *
 * Its fields say what they are (`username`, `current-password`). The form used to say
 * `autocomplete="off"` over them, which can only get in the way of a password manager filling the
 * form. Rendered for real against a server that answers the sign-in request as the API does.
 */

const ID = "request-autofill";
const SIGN_IN_REQUESTS =
  "/api/v2/organizations/default/people/me/sign-in-requests";

let originalFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register();
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function serve() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://openbot.test").pathname;
    if (path === `${SIGN_IN_REQUESTS}/${ID}`)
      return Response.json({
        signInRequest: {
          id: ID,
          botId: "default",
          origin: "https://portal.example",
          reason: null,
          status: "pending",
          method: null,
          outcome: null,
          threadId: null,
          toolCallId: null,
          controlRequestId: null,
          createdAt: "2026-10-12T10:00:00Z",
          expiresAt: "2026-10-12T10:15:00Z",
          resolvedAt: null,
          fillingUntil: null,
          passwordManager: true,
          savedLogins: [],
        },
      });
    return Response.json({ detail: "Not found" }, { status: 404 });
  }) as typeof fetch;
}

test("the login form leaves autofill to the person's password manager", async () => {
  serve();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SignInForm requestId={ID} />
    </QueryClientProvider>,
  );
  const password = await view.findByLabelText("Password");
  const form = password.closest("form");
  expect(form).not.toBeNull();
  expect(form?.getAttribute("autocomplete")).not.toBe("off");
  // The fields still say what they are.
  expect(password.getAttribute("autocomplete")).toBe("current-password");
  expect(
    view.getByLabelText("Username or email").getAttribute("autocomplete"),
  ).toBe("username");
});
