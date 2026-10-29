import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { Page } from "../src/pages/ui/page";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

type Listener = (event: { matches: boolean }) => void;

let matches = false;
let listeners: Set<Listener>;
let originalMatchMedia: typeof window.matchMedia;

beforeEach(() => {
  matches = false;
  listeners = new Set();
  document.documentElement.classList.remove("dark");
  originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    media: query,
    get matches() {
      return matches;
    },
    addEventListener: (_type: string, listener: Listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: Listener) => {
      listeners.delete(listener);
    },
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

function emit(next: boolean) {
  matches = next;
  for (const listener of [...listeners]) listener({ matches: next });
}

test("a prose page renders the title as the h1 and the description under it", () => {
  const { getByRole, getByText } = render(
    <Page title="Connect" description="Confirm the address." width="prose">
      <p>body</p>
    </Page>,
  );
  expect(getByRole("heading", { level: 1 }).textContent).toBe("Connect");
  expect(getByText("Confirm the address.").tagName).toBe("P");
  expect(getByText("body")).toBeTruthy();
});

test("a popup page renders the same header", () => {
  const { getByRole, getByText } = render(
    <Page
      title="OpenBot Recorder"
      description="Record a task."
      width="popup"
    />,
  );
  expect(getByRole("heading", { level: 1 }).textContent).toBe(
    "OpenBot Recorder",
  );
  expect(getByText("Record a task.")).toBeTruthy();
});

test("the document follows the colour scheme at mount and on change", () => {
  matches = true;
  render(<Page title="Options" width="prose" />);
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  emit(false);
  expect(document.documentElement.classList.contains("dark")).toBe(false);
  emit(true);
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});

test("a popup follows the colour scheme too", () => {
  render(<Page title="Popup" width="popup" />);
  expect(document.documentElement.classList.contains("dark")).toBe(false);
  emit(true);
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});

test("unmounting removes the listener", () => {
  const { unmount } = render(<Page title="Options" width="prose" />);
  expect(listeners.size).toBe(1);
  unmount();
  expect(listeners.size).toBe(0);
});
