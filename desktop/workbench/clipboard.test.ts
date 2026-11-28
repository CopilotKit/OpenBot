import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { copyText } from "./clipboard";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

/** A secure page has `navigator.clipboard`; an insecure one (http://<LAN address>) has none. */
function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    get: () => value,
  });
}

test("a secure page copies through navigator.clipboard", async () => {
  const writeText = mock(async (_: string) => {});
  setClipboard({ writeText });
  await copyText("hello");
  expect(writeText).toHaveBeenCalledWith("hello");
});

test("a page opened by its network address copies through a hidden text area", async () => {
  setClipboard(undefined);
  let copied = "";
  const execCommand = mock((command: string) => {
    const area = document.querySelector("textarea");
    const focused = document.activeElement === area;
    copied = command === "copy" && focused ? (area?.value ?? "") : "";
    return true;
  });
  (document as unknown as { execCommand: typeof execCommand }).execCommand =
    execCommand;
  await copyText("http://192.168.5.36:3021/workbench/?scene=x");
  expect(execCommand).toHaveBeenCalledWith("copy");
  expect(copied).toBe("http://192.168.5.36:3021/workbench/?scene=x");
  expect(document.querySelectorAll("textarea").length).toBe(0);
});

test("it throws when the browser refuses both ways", async () => {
  setClipboard(undefined);
  (document as unknown as { execCommand: () => boolean }).execCommand = () =>
    false;
  await expect(copyText("x")).rejects.toThrow(
    "The browser did not let the page copy.",
  );
  expect(document.querySelectorAll("textarea").length).toBe(0);
});
