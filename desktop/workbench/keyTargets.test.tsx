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
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { isSceneRow, isTextField, pressable, usesArrows } from "./keyTargets";
import { SceneList } from "./SceneList";

/*
 * The page's keys (Space, ".", "/", the arrows, C) must not fire while the focus is in a control
 * that uses the key itself. The panels draw with the app's Base UI components, which are not the
 * native elements the keys used to look for: a Select is a button with role combobox and a list of
 * role option, and a Slider's thumb holds the range input.
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("a Select's trigger and its options keep their keys: arrows, Space, Enter and typeahead", async () => {
  const view = render(
    <Select value="1">
      <SelectTrigger aria-label="Speed">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="1">1×</SelectItem>
        <SelectItem value="10">10×</SelectItem>
      </SelectContent>
    </Select>,
  );
  const trigger = view.getByRole("combobox", { name: "Speed" });
  expect(usesArrows(trigger)).toBe(true);
  expect(pressable(trigger)).toBe(true);
  // A closed Select picks an option by its first letters, so C, "." and "/" do nothing there.
  expect(isTextField(trigger)).toBe(true);
  await userEvent.setup({ document }).click(trigger);
  const option = await within(document.body).findByRole("option", {
    name: "10×",
  });
  expect(usesArrows(option)).toBe(true);
  expect(pressable(option)).toBe(true);
  expect(isTextField(option)).toBe(true);
  expect(isTextField(within(document.body).getByRole("listbox"))).toBe(true);
});

test("a Slider's thumb keeps its arrows, and the other keys do nothing there", () => {
  const view = render(<Slider value={[0]} thumbLabel="Time" />);
  const thumb = view.getByRole("slider", { name: "Time" });
  expect(usesArrows(thumb)).toBe(true);
  expect(isTextField(thumb)).toBe(true);
  expect(isTextField(thumb.closest("[data-slot=slider-thumb]"))).toBe(true);
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

test("a Checkbox is pressable and not a text field", () => {
  const view = render(<Checkbox aria-label="Pause at each action" />);
  const box = view.getByRole("checkbox", { name: "Pause at each action" });
  expect(pressable(box)).toBe(true);
  expect(isTextField(box)).toBe(false);
});

test("a plain element is none of them", () => {
  const view = render(<div data-testid="plain" />);
  const plain = view.getByTestId("plain");
  expect(isTextField(plain)).toBe(false);
  expect(usesArrows(plain)).toBe(false);
  expect(pressable(plain)).toBe(false);
});

test("a scene row is a scene row for Space; the group heading and Expand all are not", () => {
  const view = render(
    <SceneList
      scenes={[
        { id: "a", title: "Scene A", group: "Install" },
        { id: "b", title: "Scene B", group: "Install" },
      ]}
      current="a"
      onPick={() => {}}
      groups={["Install"]}
    />,
  );
  const row = view.getByText("Scene B");
  expect(pressable(row)).toBe(true);
  expect(isSceneRow(row)).toBe(true);
  expect(isSceneRow(view.getByRole("button", { name: "Install" }))).toBe(false);
  expect(isSceneRow(view.getByText(/^(Collapse|Expand) all$/))).toBe(false);
  expect(isSceneRow(null)).toBe(false);
});
