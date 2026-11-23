import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { isTextField, pressable, usesArrows } from "./keyTargets";

/*
 * The page's keys (Space, ".", "/", the arrows, C) must not fire while the focus is in a control
 * that uses the key itself. The panels draw with the app's Base UI components, which are not the
 * native elements the keys used to look for: a Select is a button with role combobox and a list of
 * role option, and a Slider's thumb holds the range input.
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("a Select's trigger and its options keep their arrows, Space and Enter", async () => {
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
  expect(isTextField(trigger)).toBe(false);
  await userEvent.setup({ document }).click(trigger);
  const option = await within(document.body).findByRole("option", {
    name: "10×",
  });
  expect(usesArrows(option)).toBe(true);
  expect(pressable(option)).toBe(true);
});

test("a Slider's thumb keeps its arrows", () => {
  const view = render(<Slider value={[0]} thumbLabel="Time" />);
  expect(usesArrows(view.getByRole("slider", { name: "Time" }))).toBe(true);
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
