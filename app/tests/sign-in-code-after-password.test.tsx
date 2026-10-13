import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SignInForm } from "@/components/passwords/sign-in-form";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * "All MFA codes are after the fact, none are during or before."
 *
 * The private sign-in form, rendered for real against a server that behaves like the passwords
 * routes: it asks for a username and password and nothing else, and only once the server says the
 * site sent a code (`code_required`) does it ask for that code, on its own, and send it on its own.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const PASSWORD = "correct-horse-battery-staple";
const CODE = "731904";
const ID = "request-mfa";

function serving() {
  const state = {
    id: ID,
    botId: "default",
    origin: "https://portal.example",
    reason: null,
    status: "pending",
    method: null as string | null,
    outcome: null as string | null,
    threadId: null,
    toolCallId: null,
    controlRequestId: null,
    createdAt: "2026-10-12T10:00:00Z",
    expiresAt: "2026-10-12T10:15:00Z",
    resolvedAt: null,
    fillingUntil: null,
    passwordManager: true,
    savedLogins: [],
  };
  const posted: { path: string; body: Record<string, unknown> }[] = [];
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}"));
        posted.push({ path, body });
        if (path.endsWith("/submit")) {
          state.status = "code_required";
          state.method = "typed";
        } else if (path.endsWith("/code") && body.code === CODE) {
          state.status = "signed_in";
          state.outcome = "Signed in to https://portal.example.";
        } else if (path.endsWith("/code")) {
          state.outcome =
            "The site did not accept that code. Check it, or ask the site for a new one, and try again.";
          return Response.json({ error: state.outcome }, { status: 409 });
        }
        return Response.json(state);
      }
      if (path === `/api/sign-in-requests/${ID}`) return Response.json(state);
      return Response.json({ error: "Not found" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  return { state, posted };
}

test("asks for the login first, and for the code only once the site has sent one", async () => {
  const server = serving();
  const user = userEvent.setup({ document });
  const tree = render(
    <QueryClientProvider client={queryClient}>
      <SignInForm requestId={ID} />
    </QueryClientProvider>,
  );
  const password = await tree.findByLabelText("Password");
  expect(tree.getByLabelText("Username or email")).toBeDefined();
  // Nothing about a code before the site has asked for one.
  expect(tree.queryByLabelText(/code/i)).toBeNull();
  expect(tree.queryByText(/verification code/i)).toBeNull();

  await user.type(
    tree.getByLabelText("Username or email"),
    "alice@portal.example",
  );
  await user.type(password, PASSWORD);
  await user.click(tree.getByRole("button", { name: /^Sign in$/ }));

  await tree.findByText(
    "The site sent a verification code. Enter it to finish signing in.",
  );
  // The login form is gone, and its password with it; one field is left: the code.
  expect(tree.queryByLabelText("Password")).toBeNull();
  const code = tree.getByLabelText("Verification code");
  expect(server.posted[0]?.path).toBe(`/api/sign-in-requests/${ID}/submit`);
  expect(server.posted[0]?.body).not.toHaveProperty("code");

  // A wrong code says so and keeps asking.
  await user.type(code, "000000");
  await user.click(tree.getByRole("button", { name: /Finish signing in/ }));
  await tree.findAllByText(/did not accept that code/);
  expect(tree.getByLabelText("Verification code")).toBeDefined();

  await user.type(tree.getByLabelText("Verification code"), CODE);
  await user.click(tree.getByRole("button", { name: /Finish signing in/ }));
  await tree.findByText("Signed in");
  await waitFor(() => expect(server.posted).toHaveLength(3));
  expect(server.posted.slice(1).map((post) => post.path)).toEqual([
    `/api/sign-in-requests/${ID}/code`,
    `/api/sign-in-requests/${ID}/code`,
  ]);
  // The code step carries the code and nothing else: no password is sent twice.
  expect(server.posted[2]?.body).toEqual({ code: CODE });
});
