import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { SlackLinkConfirmation } from "@/routes/_authed/link/slack";

const originalFetch = globalThis.fetch;

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function response(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function confirmation(
  token: string,
  onReauthenticate = () => {},
  load?: (
    token: string,
    signal: AbortSignal,
  ) => Promise<{
    workspace: string;
    user: string;
  }>,
  complete?: (
    token: string,
    signal: AbortSignal,
  ) => Promise<{
    kind: "linked";
    message: string;
  }>,
) {
  return (
    <StrictMode>
      <SlackLinkConfirmation
        key={token}
        complete={complete}
        load={load}
        onReauthenticate={onReauthenticate}
        token={token}
      />
    </StrictMode>
  );
}

test("a token change cannot render a delayed prior claim", async () => {
  const oldClaim = deferred<{ workspace: string; user: string }>();
  const newClaim = deferred<{ workspace: string; user: string }>();
  const signals: AbortSignal[] = [];
  const load = (token: string, signal: AbortSignal) => {
    signals.push(signal);
    return token === "token-a" ? oldClaim.promise : newClaim.promise;
  };

  const view = render(confirmation("token-a", () => {}, load));
  view.rerender(confirmation("token-b", () => {}, load));
  expect(signals.some((signal) => signal.aborted)).toBe(true);
  await act(async () => {
    oldClaim.resolve({ workspace: "old", user: "old" });
    newClaim.resolve({ workspace: "new", user: "new" });
  });

  await waitFor(() =>
    expect(view.getAllByText("new").length).toBeGreaterThan(0),
  );
  expect(view.queryByText("old")).toBeNull();
  expect(view.container.textContent).not.toContain("token-a");
  expect(view.container.textContent).not.toContain("token-b");
});

test("double-click posts once and an unmounted post cannot update a new token", async () => {
  const getA = deferred<{ workspace: string; user: string }>();
  const getB = deferred<{ workspace: string; user: string }>();
  const postA = deferred<Response>();
  const signals: AbortSignal[] = [];
  let postCalls = 0;
  const load = (token: string) =>
    token === "token-a" ? getA.promise : getB.promise;
  const complete = (_token: string, signal: AbortSignal) => {
    postCalls += 1;
    signals.push(signal);
    return postA.promise.then(() => ({
      kind: "linked" as const,
      message: "Slack is linked to your OpenBot account.",
    }));
  };

  const view = render(confirmation("token-a", () => {}, load, complete));
  await act(async () => {
    getA.resolve({ workspace: "A", user: "A" });
  });
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Link Slack" })).toBeTruthy(),
  );
  const linkButton = view.getByRole("button", { name: "Link Slack" });
  fireEvent.click(linkButton);
  expect(
    (view.getByRole("button", { name: "Linking Slack…" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(linkButton);
  expect(postCalls).toBe(1);

  view.rerender(confirmation("token-b", () => {}, load, complete));
  expect(signals[0]?.aborted).toBe(true);
  await act(async () => {
    postA.resolve(response(200, { linked: true }));
    getB.resolve({ workspace: "B", user: "B" });
  });
  await waitFor(() => expect(view.getAllByText("B").length).toBeGreaterThan(0));
  expect(
    view.queryByText("Slack is linked to your OpenBot account."),
  ).toBeNull();
});

test("a 401 starts the auth-return recovery without rendering a token", async () => {
  const reauthenticate = () => calls++;
  let calls = 0;
  globalThis.fetch = (() => Promise.resolve(response(401))) as typeof fetch;

  const view = render(confirmation("never-display-this", reauthenticate));
  await waitFor(() => expect(calls).toBeGreaterThan(0));
  expect(view.container.textContent).not.toContain("never-display-this");
});
