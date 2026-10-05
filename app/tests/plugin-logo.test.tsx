import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { PluginLogo } from "@/components/plugins/plugin-logo";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("a missing or broken logo uses the plug, and a new URL can load", () => {
  const view = render(<PluginLogo />);
  expect(view.container.querySelector("svg")).not.toBeNull();
  view.rerender(<PluginLogo logo="https://example.com/logo.svg" />);
  const image = view.container.querySelector("img");
  if (!image) throw new Error("Expected the app logo");
  expect(image.getAttribute("src")).toBe("https://example.com/logo.svg");
  fireEvent.error(image);
  expect(view.container.querySelector("img")).toBeNull();
  expect(view.container.querySelector("svg")).not.toBeNull();
  view.rerender(<PluginLogo logo="https://example.com/new-logo.svg" />);
  expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
    "https://example.com/new-logo.svg",
  );
});
