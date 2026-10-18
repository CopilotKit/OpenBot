import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { AccessPage } from "../src/pages/access/access-page";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

let fake: ChromeFake;
let originalMatchMedia: typeof window.matchMedia;
let originalClose: typeof window.close;
let closed: number;

beforeEach(() => {
  fake = installChromeFake();
  originalMatchMedia = window.matchMedia;
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  originalClose = window.close;
  closed = 0;
  window.close = () => {
    closed++;
  };
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  window.close = originalClose;
  fake.uninstall();
});

test("shows the title and one sentence, with no OpenBot or Intelligence address", async () => {
  const { getByText, findByRole, container } = render(<AccessPage />);
  expect(getByText("Let the Recorder read websites")).toBeTruthy();
  expect(
    getByText(
      "Chrome needs your permission before the Recorder can record what happens on a website. It asks once.",
    ),
  ).toBeTruthy();
  expect(
    await findByRole("button", { name: "Allow access to websites" }),
  ).toBeTruthy();
  const text = container.textContent ?? "";
  expect(text).not.toMatch(/https?:\/\//);
  expect(text).not.toMatch(/Intelligence/);
  expect(text).not.toMatch(/OpenBot (?!Recorder)/);
});

test("Allow requests <all_urls> in the click and says it is done", async () => {
  const { findByRole, findByText } = render(<AccessPage />);
  fireEvent.click(
    await findByRole("button", { name: "Allow access to websites" }),
  );
  expect(
    await findByText(
      "Done. Open the Recorder from the toolbar and press Record.",
    ),
  ).toBeTruthy();
  expect(fake.permissions.requests).toEqual([{ origins: ["<all_urls>"] }]);
});

test("a denied request shows the retry sentence and asks again on the next click", async () => {
  fake.permissions.answer = false;
  const { findByRole, findByText } = render(<AccessPage />);
  const button = await findByRole("button", {
    name: "Allow access to websites",
  });
  fireEvent.click(button);
  expect(
    await findByText(
      "The Recorder needs access to websites to record them. Choose Allow access to websites to try again.",
    ),
  ).toBeTruthy();
  await waitFor(() => expect(fake.permissions.requests.length).toBe(1));
  fake.permissions.answer = true;
  fireEvent.click(
    await findByRole("button", { name: "Allow access to websites" }),
  );
  expect(
    await findByText(
      "Done. Open the Recorder from the toolbar and press Record.",
    ),
  ).toBeTruthy();
  expect(fake.permissions.requests.length).toBe(2);
});

test("already held: says so and offers nothing", async () => {
  fake.permissions.granted.add("<all_urls>");
  const { findByText, queryByRole } = render(<AccessPage />);
  expect(
    await findByText("The Recorder can already read websites."),
  ).toBeTruthy();
  expect(queryByRole("button")).toBeNull();
  expect(fake.permissions.requests).toEqual([]);
});

test("Not now closes the tab and requests nothing", async () => {
  const { findByRole } = render(<AccessPage />);
  fireEvent.click(await findByRole("button", { name: "Not now" }));
  expect(closed).toBe(1);
  expect(fake.permissions.requests).toEqual([]);
});
