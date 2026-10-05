import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";

/**
 * The sidebar shortcut on a keyboard layout that does not write Latin letters.
 *
 * The toggle's tooltip names it as Ctrl+B, or ⌘B on a Mac, and the sidebar's listener compared
 * `KeyboardEvent.key` with "b". On Russian the B key writes "и", and on Greek it writes "β", so the
 * shortcut the tooltip names never fired for anybody with one of those layouts selected. It is the
 * same miss Shift+N and the paste shortcut on a Bot's screen had.
 */

beforeAll(() => {
  GlobalRegistrator.register();
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function SidebarState() {
  return <output>{useSidebar().open ? "open" : "closed"}</output>;
}

type Modifiers = Partial<Pick<KeyboardEvent, "ctrlKey" | "metaKey">>;

/**
 * A sidebar, and a way to press a key at it that answers with the state it is left in.
 *
 * The keydown is the one a browser reports: `key` from the layout, `code` from the physical key.
 */
function renderSidebar() {
  const { container } = render(
    <SidebarProvider>
      <SidebarState />
    </SidebarProvider>,
  );
  return (key: string, code: string, modifiers: Modifiers) => {
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          code,
          ...modifiers,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    return container.querySelector("output")?.textContent;
  };
}

test("Ctrl+B and Cmd+B toggle the sidebar on a layout that writes another script", () => {
  const press = renderSidebar();

  expect(press("и", "KeyB", { ctrlKey: true })).toBe("closed");
  expect(press("β", "KeyB", { metaKey: true })).toBe("open");
});

test("a layout that writes Latin letters still goes by the letter, wherever its key is", () => {
  const press = renderSidebar();

  // Dvorak writes B on the key QWERTY calls N, and X on the key QWERTY calls B.
  expect(press("b", "KeyN", { ctrlKey: true })).toBe("closed");
  expect(press("x", "KeyB", { ctrlKey: true })).toBe("closed");
});

test("another letter, or the B key without its modifier, still does nothing", () => {
  const press = renderSidebar();

  expect(press("т", "KeyN", { ctrlKey: true })).toBe("open");
  expect(press("и", "KeyB", {})).toBe("open");
});
