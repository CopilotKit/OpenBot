import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

/**
 * Base UI reports a button drawn as the wrong element through `console.error`, from an effect, so
 * the only way to assert the app renders quietly is to collect what a render logs.
 *
 * The DOM assertions below carry the real weight. Base UI remembers every message it has already
 * printed for the life of the process, so an empty log is evidence only as long as nothing earlier
 * said the same thing. `role` and `type` on the rendered element say what `nativeButton` resolved to
 * no matter what else has run.
 */
function drawing(element: ReactElement) {
  const logged: string[] = [];
  const spy = spyOn(console, "error").mockImplementation(
    (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    },
  );

  try {
    const { container } = render(element);
    return {
      complaints: logged.filter((message) => message.startsWith("Base UI:")),
      element: container.firstElementChild as HTMLElement,
    };
  } finally {
    spy.mockRestore();
  }
}

test("a button with no `render` is still a native button", () => {
  const { complaints, element } = drawing(<Button>Save</Button>);

  expect(complaints).toEqual([]);
  expect(element.tagName).toBe("BUTTON");
  expect(element.getAttribute("type")).toBe("button");
  expect(element.getAttribute("role")).toBeNull();
});

test("a button drawn as a link takes button semantics rather than `type`", () => {
  const { complaints, element } = drawing(
    <Button render={<a href="/settings" />}>Settings</Button>,
  );

  expect(complaints).toEqual([]);
  expect(element.tagName).toBe("A");
  expect(element.getAttribute("role")).toBe("button");
  expect(element.getAttribute("type")).toBeNull();
});

/**
 * The shape `PageShell`'s back button and the sidebar's links use: a function, because a router
 * `Link` takes its own props alongside the ones Base UI merges in.
 */
test("a button drawn as a link through the function form does the same", () => {
  const { complaints, element } = drawing(
    <Button render={(props) => <a href="/agents" {...props} />}>Agents</Button>,
  );

  expect(complaints).toEqual([]);
  expect(element.tagName).toBe("A");
  expect(element.getAttribute("role")).toBe("button");
});

/**
 * `render` that draws a real button is the case the default cannot see, so a call site says so —
 * `combobox.tsx` is the one that does.
 */
test("a call site drawing a real button can say so", () => {
  const { complaints, element } = drawing(
    <Button nativeButton render={<button type="button" />}>
      Open
    </Button>,
  );

  expect(complaints).toEqual([]);
  expect(element.tagName).toBe("BUTTON");
  expect(element.getAttribute("role")).toBeNull();
});
