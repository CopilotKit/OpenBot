import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { isTextField } from "./keyTargets";

// C keeps typing in fields, selects and comment popups.
beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("a Select's trigger and its options keep their keys: arrows, Space, Enter and typeahead", async () => {
  const view = render(
    <Select value="1">
      <SelectTrigger aria-label="Theme">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="1">1×</SelectItem>
        <SelectItem value="10">10×</SelectItem>
      </SelectContent>
    </Select>,
  );
  const trigger = view.getByRole("combobox", { name: "Theme" });
  // A closed Select picks an option by its first letters, so C, "." and "/" do nothing there.
  expect(isTextField(trigger)).toBe(true);
  await userEvent.setup({ document }).click(trigger);
  const option = await within(document.body).findByRole("option", {
    name: "10×",
  });
  expect(isTextField(option)).toBe(true);
  expect(isTextField(within(document.body).getByRole("listbox"))).toBe(true);
});

test("in a popup, on the popup or a button in it, the page's keys do nothing", async () => {
  render(
    <Popover>
      <PopoverTrigger>Keys</PopoverTrigger>
      <PopoverContent aria-label="Keys">
        <button type="button">Cancel</button>
      </PopoverContent>
    </Popover>,
  );
  const body = within(document.body);
  expect(isTextField(body.getByRole("button", { name: "Keys" }))).toBe(false);
  await userEvent.setup({ document }).click(body.getByText("Keys"));
  const popup = await body.findByRole("dialog", { name: "Keys" });
  expect(isTextField(popup)).toBe(true);
  expect(isTextField(body.getByRole("button", { name: "Cancel" }))).toBe(true);
});

test("an Input and a Textarea are text fields, so C types a letter there", () => {
  const view = render(
    <>
      <Input aria-label="Filter" />
      <Textarea aria-label="Comment" />
    </>,
  );
  expect(isTextField(view.getByRole("textbox", { name: "Filter" }))).toBe(true);
  expect(isTextField(view.getByRole("textbox", { name: "Comment" }))).toBe(
    true,
  );
});

test("a Checkbox is not a text field", () => {
  const view = render(<Checkbox aria-label="Grid" />);
  const box = view.getByRole("checkbox", { name: "Grid" });
  expect(isTextField(box)).toBe(false);
});

test("a plain element is none of them", () => {
  const view = render(<div data-testid="plain" />);
  const plain = view.getByTestId("plain");
  expect(isTextField(plain)).toBe(false);
});
