import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NameRow } from "@/components/settings/profile";
import { StandingInstructionsRow } from "@/components/settings/standing-instructions";
import { authKeys } from "@/lib/auth/queries";
import { settingsKeys } from "@/lib/settings/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * General's two free-text answers, drawn as the layout has every free text: a row that states the answer, and a dialog
 * that changes it.
 */

beforeAll(() => GlobalRegistrator.register());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
let instructions = "";

beforeEach(() => {
  queryClient.clear();
  instructions = "";
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const path = String(input);
      if (path === "/api/settings/instructions")
        return Response.json({ instructions });
      if (path === "/api/me")
        return Response.json({
          user: { id: "ada", email: "ada@example.com", name: "Ada" },
        });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function draw() {
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "ada",
    email: "ada@example.com",
    name: "Ada",
    needsName: false,
  } as never);
  return render(
    <QueryClientProvider client={queryClient}>
      <NameRow />
      <StandingInstructionsRow />
    </QueryClientProvider>,
  );
}

test("the name is a row that states it and opens a dialog to change it", async () => {
  const view = draw();
  const row = view.getByRole("button", { name: /^Name/ });
  expect(row.textContent).toContain("Ada");
  await userEvent.setup({ document }).click(row);
  const dialog = await view.findByRole("dialog");
  expect(
    (within(dialog).getByLabelText("Name") as HTMLInputElement).value,
  ).toBe("Ada");
  expect(
    within(dialog).getByRole("button", { name: "Save name" }),
  ).toBeTruthy();
});

test("standing instructions are a row that says what they are, or that there are none yet", async () => {
  const view = draw();
  const row = await view.findByRole("button", {
    name: /None yet\. Tell every Bot how you want things done\./,
  });
  await userEvent.setup({ document }).click(row);
  const dialog = await view.findByRole("dialog");
  expect(
    await within(dialog).findByRole("textbox", {
      name: "Standing instructions",
    }),
  ).toBeTruthy();
  cleanup();

  queryClient.clear();
  instructions = "Write in British English.";
  queryClient.setQueryData(settingsKeys.instructions(), instructions);
  const written = draw();
  expect(
    await written.findByRole("button", { name: /Write in British English\./ }),
  ).toBeTruthy();
});
