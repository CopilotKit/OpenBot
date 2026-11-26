import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { WindowFrame, type WindowFrameProps } from "./WindowFrame";

beforeAll(() =>
  GlobalRegistrator.register({
    settings: { navigation: { disableChildPageNavigation: true } },
  }),
);
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

function props(extra: Partial<WindowFrameProps> = {}): WindowFrameProps {
  return {
    src: "about:blank",
    frameKey: "k",
    width: 1000,
    height: 800,
    os: "mac",
    active: true,
    theme: "light",
    zoom: 1,
    grid: false,
    gridColor: "#ff0000",
    ...extra,
  };
}

function iframeSize(container: HTMLElement) {
  const iframe = container.querySelector("iframe") as HTMLIFrameElement;
  return { width: iframe.style.width, height: iframe.style.height };
}

test("host browser shows the browser bar with the address and no Mac lights", () => {
  const { container } = render(
    <WindowFrame {...props({ host: "browser", address: "/settings/ai" })} />,
  );
  const bar = container.querySelector("[data-window-bar=browser]");
  expect(bar).not.toBeNull();
  expect(bar?.textContent).toContain("http://localhost:3010/settings/ai");
  expect(container.querySelector("[data-window-bar=mac]")).toBeNull();
  expect(container.querySelector("[data-window-button]")).toBeNull();
  // The bar sits above the iframe, not over it.
  expect(bar?.closest("[data-window-content]")).toBeNull();
  expect(iframeSize(container)).toEqual({ width: "1000px", height: "800px" });
});

test("the Windows bar says OpenBot over the app and nothing over setup", () => {
  const titled = render(<WindowFrame {...props({ os: "windows" })} />);
  expect(titled.container.querySelector(".wb-window-title")?.textContent).toBe(
    "OpenBot",
  );
  cleanup();
  const setup = render(
    <WindowFrame {...props({ os: "windows", titled: false })} />,
  );
  expect(
    setup.container.querySelector("[data-window-bar=windows]"),
  ).not.toBeNull();
  expect(setup.container.querySelector(".wb-window-title")?.textContent).toBe(
    "",
  );
});

test("host browser with no address shows the root path", () => {
  const { container } = render(<WindowFrame {...props({ host: "browser" })} />);
  expect(container.querySelector("[data-browser-address]")?.textContent).toBe(
    "http://localhost:3010/",
  );
});

test("no host shows the Mac bar", () => {
  const { container } = render(
    <WindowFrame {...props({ width: 720, height: 560 })} />,
  );
  expect(container.querySelector("[data-window-bar=mac]")).not.toBeNull();
  expect(container.querySelectorAll("[data-window-button]")).toHaveLength(3);
  expect(container.querySelector("[data-window-bar=browser]")).toBeNull();
  expect(iframeSize(container)).toEqual({ width: "720px", height: "560px" });
});

test("the Mac lights sit where macOS draws them: 21, 41 and 61 px in, 26.5 px down", () => {
  const { container } = render(<WindowFrame {...props()} />);
  const lights = Array.from(
    container.querySelectorAll<HTMLElement>("[data-window-button]"),
  );
  expect(lights.map((l) => [l.style.left, l.style.top, l.style.width])).toEqual(
    [
      ["21px", "26.5px", "12px"],
      ["41px", "26.5px", "12px"],
      ["61px", "26.5px", "12px"],
    ],
  );
  // Over the page: after the iframe in the window's content.
  const bar = container.querySelector("[data-window-bar=mac]");
  expect(bar?.closest("[data-window-content]")).not.toBeNull();
});

async function hover(container: HTMLElement) {
  const iframe = container.querySelector("iframe") as HTMLIFrameElement;
  await act(() => new Promise((done) => setTimeout(done, 50)));
  const doc = iframe.contentDocument as Document;
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  await act(async () => {
    box.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    await new Promise((done) => setTimeout(done, 50));
  });
  return container.querySelector("[data-workbench-inspector]");
}

test("the inspector outlines the element under the pointer", async () => {
  const { container } = render(<WindowFrame {...props()} />);
  expect(await hover(container)).not.toBeNull();
});

test("inspect false draws nothing over the app, so the pointer just clicks through", async () => {
  const { container } = render(<WindowFrame {...props({ inspect: false })} />);
  expect(await hover(container)).toBeNull();
});
