import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/*
 * The workbench page draws with the app's own components (README, "The rule"). They must render
 * with the workbench's React: a second copy of React fails only at run time, with "Invalid hook
 * call".
 */
const errors: string[] = [];
const consoleError = console.error;
beforeAll(() => {
  GlobalRegistrator.register();
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
    consoleError(...args);
  };
});
afterEach(cleanup);
afterAll(() => {
  console.error = consoleError;
  GlobalRegistrator.unregister();
});

test("an app Button renders with the workbench's React", () => {
  const view = render(<Button>Play</Button>);
  expect(view.getByRole("button", { name: "Play" })).toBeDefined();
  expect(errors.filter((e) => e.includes("Invalid hook call"))).toEqual([]);
});

test("an app Select picks an option", async () => {
  const picked = mock((_: string | null) => {});
  const view = render(
    <Select value="1×" onValueChange={picked}>
      <SelectTrigger aria-label="Speed">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="1×">1×</SelectItem>
        <SelectItem value="10×">10×</SelectItem>
      </SelectContent>
    </Select>,
  );
  const person = userEvent.setup({ document });
  await person.click(view.getByRole("combobox", { name: "Speed" }));
  // The list is in a portal on document.body, outside the rendered container.
  const page = within(document.body);
  await person.click(await page.findByRole("option", { name: "10×" }));
  expect(picked.mock.calls[0]?.[0]).toBe("10×");
});
