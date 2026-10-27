import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  FirstRunNamePrompt,
  ProfileNameForm,
} from "@/components/settings/profile";
import { authKeys } from "@/lib/auth/queries";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function client(needsName = true) {
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  query.setQueryData(authKeys.currentUser(), {
    id: "existing-user",
    email: "dev@openbot.local",
    name: needsName ? "dev@openbot.local" : "Sam",
    needsName,
    onboarding: { completedAt: "2026-01-01", step: 0 },
  });
  return query;
}

test("asks existing users without a name even when onboarding is completed", () => {
  const view = render(
    <QueryClientProvider client={client()}>
      <FirstRunNamePrompt />
    </QueryClientProvider>,
  );
  expect(
    view.getByRole("heading", { name: "What should we call you?" }),
  ).toBeTruthy();
  expect(
    view.getByRole("button", { name: "Continue" }).hasAttribute("disabled"),
  ).toBe(true);
});

test("does not ask again when a saved name is present", () => {
  const view = render(
    <QueryClientProvider client={client(false)}>
      <FirstRunNamePrompt />
    </QueryClientProvider>,
  );
  expect(view.queryByRole("dialog")).toBeNull();
});

test("settings saves only the display name and refreshes the current user", async () => {
  const query = client(false);
  let sent: unknown;
  globalThis.fetch = Object.assign(
    async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ profile: { name: "Samuel", needsName: false } });
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = render(
    <QueryClientProvider client={query}>
      <ProfileNameForm initialName="Sam" />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  await user.clear(view.getByLabelText("Name"));
  await user.type(view.getByLabelText("Name"), " Samuel ");
  fireEvent.click(view.getByRole("button", { name: "Save name" }));
  await waitFor(() =>
    expect(view.getByRole("status").textContent).toBe(
      "Your name has been saved.",
    ),
  );
  expect(sent).toEqual({ name: "Samuel" });
  expect(query.getQueryState(authKeys.currentUser())?.isInvalidated).toBe(true);
});

test("failed saves show an error and preserve the draft for retry", async () => {
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({ error: "Could not save your profile." }, { status: 500 }),
    { preconnect: originalFetch.preconnect },
  );
  const view = render(
    <QueryClientProvider client={client(false)}>
      <ProfileNameForm initialName="Sam" />
    </QueryClientProvider>,
  );
  fireEvent.click(view.getByRole("button", { name: "Save name" }));
  await waitFor(() =>
    expect(view.getByRole("alert").textContent).toContain(
      "Could not save your profile.",
    ),
  );
  expect((view.getByLabelText("Name") as HTMLInputElement).value).toBe("Sam");
});
