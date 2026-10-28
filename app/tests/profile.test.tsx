import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  OnboardingNameStep,
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

test("onboarding name step starts empty for a placeholder profile", () => {
  const view = render(
    <QueryClientProvider client={client()}>
      <OnboardingNameStep onSaved={() => {}} />
    </QueryClientProvider>,
  );
  expect(view.getByRole("heading", { name: "Let's get to it." })).toBeTruthy();
  expect(
    view.getByRole("button", { name: "Get started" }).hasAttribute("disabled"),
  ).toBe(true);
});

test("onboarding name step preserves a saved name when revisited", () => {
  const view = render(
    <QueryClientProvider client={client(false)}>
      <OnboardingNameStep onSaved={() => {}} />
    </QueryClientProvider>,
  );
  expect((view.getByLabelText("Name") as HTMLInputElement).value).toBe("Sam");
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

test("an untouched settings form reflects a name saved by the welcome dialog", () => {
  const query = client();
  const view = render(
    <QueryClientProvider client={query}>
      <ProfileNameForm initialName="" />
    </QueryClientProvider>,
  );
  view.rerender(
    <QueryClientProvider client={query}>
      <ProfileNameForm initialName="Sam" />
    </QueryClientProvider>,
  );
  expect((view.getByLabelText("Name") as HTMLInputElement).value).toBe("Sam");
});

test("a profile refetch does not overwrite an unsaved draft", async () => {
  const query = client(false);
  const view = render(
    <QueryClientProvider client={query}>
      <ProfileNameForm initialName="Sam" />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  await user.type(view.getByLabelText("Name"), " Julien");
  view.rerender(
    <QueryClientProvider client={query}>
      <ProfileNameForm initialName="Samuel" />
    </QueryClientProvider>,
  );
  expect((view.getByLabelText("Name") as HTMLInputElement).value).toBe(
    "Sam Julien",
  );
});

test("onboarding advances only after the name has been saved", async () => {
  let finishSave: (response: Response) => void = () => {};
  const response = new Promise<Response>((resolve) => {
    finishSave = resolve;
  });
  globalThis.fetch = Object.assign(async () => response, {
    preconnect: originalFetch.preconnect,
  });
  let advances = 0;
  const view = render(
    <QueryClientProvider client={client(false)}>
      <OnboardingNameStep
        onSaved={() => {
          advances += 1;
        }}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(view.getByRole("button", { name: "Get started" }));
  await waitFor(() =>
    expect(
      view.getByRole("button", { name: "Saving…" }).hasAttribute("disabled"),
    ).toBe(true),
  );
  expect(advances).toBe(0);
  finishSave(Response.json({ profile: { name: "Sam", needsName: false } }));
  await waitFor(() => expect(advances).toBe(1));
});

test("onboarding stays on the name step when saving fails", async () => {
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "Save failed" }, { status: 500 }),
    { preconnect: originalFetch.preconnect },
  );
  let advances = 0;
  const view = render(
    <QueryClientProvider client={client(false)}>
      <OnboardingNameStep
        onSaved={() => {
          advances += 1;
        }}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(view.getByRole("button", { name: "Get started" }));
  await view.findByRole("alert");
  expect(advances).toBe(0);
  expect((view.getByLabelText("Name") as HTMLInputElement).value).toBe("Sam");
});
