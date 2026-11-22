import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
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
  const bar = container.querySelector(".wb-window-bar-browser");
  expect(bar).not.toBeNull();
  expect(bar?.textContent).toContain("http://localhost:3010/settings/ai");
  expect(container.querySelector(".wb-window-bar-mac")).toBeNull();
  expect(container.querySelector(".wb-window-light")).toBeNull();
  // The bar sits above the iframe, not over it.
  expect(bar?.closest(".wb-window-content")).toBeNull();
  expect(iframeSize(container)).toEqual({ width: "1000px", height: "800px" });
});

test("host browser with no address shows the root path", () => {
  const { container } = render(<WindowFrame {...props({ host: "browser" })} />);
  expect(container.querySelector(".wb-browser-address")?.textContent).toBe(
    "http://localhost:3010/",
  );
});

test("no host shows the Mac bar", () => {
  const { container } = render(
    <WindowFrame {...props({ width: 720, height: 560 })} />,
  );
  expect(container.querySelector(".wb-window-bar-mac")).not.toBeNull();
  expect(container.querySelectorAll(".wb-window-light")).toHaveLength(3);
  expect(container.querySelector(".wb-window-bar-browser")).toBeNull();
  expect(iframeSize(container)).toEqual({ width: "720px", height: "560px" });
});
