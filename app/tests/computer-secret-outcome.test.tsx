import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ComputerView } from "@/components/computer/computer-view";
import type { ControlState } from "@/lib/computers/control";
import { secretAnswer, secretRequestOver } from "@/lib/computers/secret";
import { settleReactWork } from "./settle-react-work";

/**
 * The masked box, when the request it answers has already ended.
 *
 * The Mac pass: the person typed a password into the box and pressed Send to the page. The computer
 * answered 409, nothing waiting for a secret, so the box closed with the request and took its error
 * with it. The Bot, waiting for the box to go, read that as the password typed and pressed Sign in on
 * an empty field. Now the Bot is told nothing was typed unless the computer says this request's value
 * was, and the person keeps the reason on screen.
 */

const label = "the password for robin.okafor";
const base: ControlState = {
  holder: "bot",
  since: "2026-11-13T00:00:00.000Z",
  requested: false,
  transitioning: false,
  resumeSnapshotRequired: false,
  recoveryRequired: false,
};

test("the Bot is told it was typed only when the computer says this request's value was", () => {
  const typed = {
    ...base,
    secretEnded: { id: "secret-1", supplied: true },
  };
  expect(secretRequestOver("secret-1", typed)).toBe(true);
  const answer = secretAnswer(label, "secret-1", "answered", typed);
  expect(answer.ok).toBe(true);
  expect(answer.result).toContain("has entered");
});

test("a request that ended without a value is said as nothing typed, with the computer's reason", () => {
  // What the computer says when its browser restarted under the request.
  const restarted = {
    ...base,
    secretEnded: {
      id: "secret-1",
      supplied: false,
      reason:
        "The browser was stopped or replaced; request help again to continue.",
    },
  };
  expect(secretRequestOver("secret-1", restarted)).toBe(true);
  const answer = secretAnswer(label, "secret-1", "answered", restarted);
  expect(answer.ok).toBe(false);
  expect(answer.result).not.toContain("has entered");
  expect(answer.result).toContain("The browser was stopped or replaced");
  expect(answer.result).toContain("don't submit the form");
});

test("a request replaced by another, or gone with no ending recorded, is not called typed", () => {
  const replaced = {
    ...base,
    secretId: "secret-2",
    secretWanted: "the code",
  };
  expect(secretRequestOver("secret-1", replaced)).toBe(true);
  expect(secretAnswer(label, "secret-1", "answered", replaced).ok).toBe(false);
  // Still the same request: not over yet.
  expect(
    secretRequestOver("secret-1", {
      ...base,
      secretId: "secret-1",
      secretWanted: label,
    }),
  ).toBe(false);
});

// ---- The box ----

let originalFetch: typeof fetch;
beforeAll(() => {
  GlobalRegistrator.register();
  originalFetch = globalThis.fetch;
  Reflect.deleteProperty(globalThis, "IntersectionObserver");
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

test("a send the computer refuses because the request ended leaves its reason on screen", async () => {
  let ended = false;
  const refusal =
    "That request has ended, so nothing was typed. The Bot will ask again if it still needs it.";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/human/secret") && init?.method === "POST") {
      ended = true;
      return Response.json({ error: refusal }, { status: 409 });
    }
    if (path.endsWith("/control"))
      return Response.json(
        ended
          ? base
          : {
              ...base,
              secretId: "secret-1",
              secretWanted: label,
              secretRef: "e5",
            },
      );
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <ComputerView active computerId="sales" intervalMs={10} name="Sales" />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText(/The Bot needs/), "fern-hill-42");
  await user.click(view.getByRole("button", { name: "Send to the page" }));

  // The box goes with the request, and what happened stays.
  await waitFor(() =>
    expect(view.queryByLabelText(/The Bot needs/)).toBeNull(),
  );
  expect((await view.findByRole("alert")).textContent).toBe(refusal);
  // And nothing typed is left anywhere on the page.
  expect(document.body.innerHTML).not.toContain("fern-hill-42");
});
