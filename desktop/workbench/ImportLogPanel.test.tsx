import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ImportLogPanel, importCommand, sceneFromLog } from "./ImportLogPanel";
import type { Scene } from "./scenes/types";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

// A hand-written file in the shape the troubleshooting bundle has. No real data.
const LOG = [
  "Summary: OpenBot Desktop 9.9.9 (Built 2026-01-01 from abc1234) on macos aarch64.",
  "",
  "## What failed",
  "",
  "Nothing reported a failure.",
  "",
  "## OpenBot Desktop log (end)",
  "",
  "2026-01-02T10:00:00.000Z INFO  [launch] OpenBot Desktop 9.9.9 on macos aarch64",
  "2026-01-02T10:00:01.000Z INFO  [step engine] Checking the software OpenBot needs.",
  "2026-01-02T10:00:03.000Z INFO  [step engine] docker is answering.",
].join("\n");

test("sceneFromLog makes a first run that presses Install, or a relaunch", () => {
  const first = sceneFromLog(LOG, "first-run");
  if (!("scene" in first)) throw new Error(first.problem);
  expect(first.scene.start.hash).toBe("");
  expect(first.scene.run?.[0]).toEqual({ at: 0.5, click: "Install" });
  const again = sceneFromLog(LOG, "relaunch");
  if (!("scene" in again)) throw new Error(again.problem);
  expect(again.scene.start.hash).toBe("#start");
});

test("sceneFromLog says what is wrong with a file that has no log", () => {
  expect(sceneFromLog("hello", "first-run")).toEqual({
    problem: expect.stringContaining("no OpenBot Desktop log"),
  });
});

test("importCommand names the CLI, with the start", () => {
  expect(importCommand("first-run")).toBe("bun run workbench:import <file>");
  expect(importCommand("relaunch")).toBe(
    "bun run workbench:import <file> --start relaunch",
  );
});

test("a chosen file becomes a scene; imported scenes show and can be picked", async () => {
  const onImport = mock((_scene: Scene) => {});
  const onPick = mock((_id: string) => {});
  const imported: Scene = {
    id: "log-x",
    title: "Install (from a log)",
    group: "Install",
    start: { hash: "", search: "" },
  };
  const view = render(
    <ImportLogPanel
      scenes={[imported]}
      current="other"
      onImport={onImport}
      onPick={onPick}
    />,
  );
  fireEvent.change(view.getByLabelText("Start"), {
    target: { value: "relaunch" },
  });
  expect(
    view.getByText("bun run workbench:import <file> --start relaunch"),
  ).toBeTruthy();
  const input = view.getByLabelText("Troubleshooting file") as HTMLInputElement;
  const file = new File([LOG], "log.md", { type: "text/markdown" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
  await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
  expect(onImport.mock.calls[0]?.[0].start.hash).toBe("#start");
  fireEvent.click(view.getByText("Install (from a log)"));
  expect(onPick).toHaveBeenCalledWith("log-x");
});
