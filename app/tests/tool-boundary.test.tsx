import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ToolRenderBoundary } from "@/components/channels/tool-boundary";
import { settleReactWork } from "./settle-react-work";

/**
 * A card drawn from a tool call that is still streaming can throw on arguments that are only half
 * there, and be perfectly drawable a chunk later. The boundary gives it that chance; only a throw on
 * the complete arguments is final.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function Fragile({ args }: { args: string }) {
  if (args === "bad" || args === "still bad") throw new Error("half-sent");
  return <p>drawn {args}</p>;
}

const FALLBACK = /Couldn't show/;

test("recovers on the next chunk", () => {
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  const view = render(
    <ToolRenderBoundary name="Chart" resetKey="bad">
      <Fragile args="bad" />
    </ToolRenderBoundary>,
  );
  expect(view.getByText(FALLBACK)).toBeTruthy();

  view.rerender(
    <ToolRenderBoundary name="Chart" resetKey="good">
      <Fragile args="good" />
    </ToolRenderBoundary>,
  );

  expect(view.getByText("drawn good")).toBeTruthy();
  quiet.mockRestore();
});

test("stays failed once the call is complete", () => {
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  const view = render(
    <ToolRenderBoundary final name="Chart" resetKey="bad">
      <Fragile args="bad" />
    </ToolRenderBoundary>,
  );

  view.rerender(
    <ToolRenderBoundary final name="Chart" resetKey="other">
      <Fragile args="still bad" />
    </ToolRenderBoundary>,
  );

  expect(view.getByText(FALLBACK)).toBeTruthy();
  quiet.mockRestore();
});

test("no reset key keeps today's behaviour", () => {
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  const view = render(
    <ToolRenderBoundary name="Chart">
      <Fragile args="bad" />
    </ToolRenderBoundary>,
  );

  view.rerender(
    <ToolRenderBoundary name="Chart">
      <Fragile args="good" />
    </ToolRenderBoundary>,
  );

  expect(view.getByText(FALLBACK)).toBeTruthy();
  quiet.mockRestore();
});
