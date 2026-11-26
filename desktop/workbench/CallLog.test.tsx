import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, within } from "@testing-library/react";
import { nativeControl } from "../src/fakeNative/control";
import { invoke } from "../src/fakeNative/core";
import { CallLog } from "./CallLog";

beforeAll(() =>
  GlobalRegistrator.register({
    settings: { navigation: { disableChildPageNavigation: true } },
  }),
);
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("shows no calls at first", () => {
  const control = nativeControl();
  control.reset();
  const { getByText } = render(<CallLog control={control} />);
  expect(getByText("No calls yet.")).not.toBeNull();
});

test("lists calls newest first and flags unknown commands", async () => {
  const control = nativeControl();
  control.reset();
  await invoke("default_root");
  await invoke("no_such_command");
  const { getAllByTestId } = render(<CallLog control={control} />);
  const rows = getAllByTestId("call");
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain("no_such_command");
  expect(rows[0]?.textContent).toContain("Not in the registry");
  expect(rows[1]?.textContent).toContain("default_root");
  expect(rows[1]?.textContent).not.toContain("Not in the registry");
});

test("shows a call made after render", async () => {
  const control = nativeControl();
  control.reset();
  const { queryAllByTestId } = render(<CallLog control={control} />);
  expect(queryAllByTestId("call")).toHaveLength(0);
  await act(async () => {
    await invoke("default_root");
  });
  expect(queryAllByTestId("call")).toHaveLength(1);
});

test("the calls are rows of a table with a header", async () => {
  const control = nativeControl();
  control.reset();
  await invoke("default_root");
  const view = render(<CallLog control={control} />);
  const table = view.getByRole("table");
  const heads = within(table).getAllByRole("columnheader");
  expect(heads.map((head) => head.textContent)).toEqual([
    "Time",
    "Command",
    "Arguments",
  ]);
  const row = within(table).getByTestId("call");
  expect(within(row).getAllByRole("cell")[1]?.textContent).toBe("default_root");
});
