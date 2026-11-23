import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KEYS, KeysHelp } from "./KeysHelp";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("the Keys button opens the list of keys", async () => {
  const view = render(<KeysHelp />);
  const button = view.getByRole("button", { name: "Keys" });
  await userEvent.setup({ document }).click(button);
  const page = within(document.body);
  expect(await page.findByRole("heading", { name: "Keys" })).toBeDefined();
  for (const row of KEYS) expect(page.getByText(row.what)).toBeDefined();
  expect(
    page.getByText("The keys do nothing while you type in a field."),
  ).toBeDefined();
});
