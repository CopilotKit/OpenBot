import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ApiChange, ApiControl, ApiRecord } from "./appContract";
import { RequestLog } from "./RequestLog";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

function fakeApi(records: ApiRecord[]) {
  const listeners = new Set<(change: ApiChange) => void>();
  const api: ApiControl = {
    setAnswer() {},
    clearAnswer() {},
    answers: () => new Map(),
    requests: () => records,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    api,
    add(record: ApiRecord) {
      records.push(record);
      for (const listener of listeners) listener({ kind: "request", record });
    },
  };
}

function record(id: number, fields: Partial<ApiRecord>): ApiRecord {
  return {
    id,
    method: "GET",
    path: "/api/v2/organizations/default/bots",
    at: id * 1000,
    source: "spec",
    route: null,
    status: 200,
    state: "answered",
    ...fields,
  };
}

function edit(el: HTMLElement, value: string) {
  fireEvent.focusIn(el);
  fireEvent.change(el, { target: { value } });
  fireEvent.keyUp(el);
}

test("with no window it says so", () => {
  const view = render(<RequestLog api={null} />);
  expect(view.getByText("No window is loaded.")).not.toBeNull();
});

test("lists requests newest first with status, source and time", () => {
  const { api } = fakeApi([
    record(1, { path: "/api/v2/person" }),
    record(2, {
      path: "/api/v2/organizations/default/bots",
      source: "answer",
      status: null,
      state: "pending",
    }),
  ]);
  const view = render(<RequestLog api={api} />);
  const rows = view.getAllByTestId("request");
  expect(rows).toHaveLength(2);
  // One line: the organization part is "…"; the tooltip has all of the path.
  expect(rows[0]?.textContent).toContain("…/bots");
  expect(rows[0]?.textContent).not.toContain("organizations");
  expect(rows[0]?.getAttribute("title")).toBe(
    "GET /api/v2/organizations/default/bots",
  );
  expect(rows[0]?.textContent).toContain("Waiting");
  expect(rows[0]?.textContent).toContain("Scene answer");
  expect(rows[0]?.textContent).toContain("0:02");
  expect(rows[1]?.querySelector(".wb-req-method")?.textContent).toBe("GET");
  expect(rows[1]?.querySelector(".wb-req-route")?.textContent).toBe(
    "/api/v2/person",
  );
  expect(rows[1]?.textContent).toContain("200");
  expect(rows[1]?.textContent).toContain("Spec example");
});

test("shows a request made after render", () => {
  const fake = fakeApi([]);
  const view = render(<RequestLog api={fake.api} />);
  expect(view.queryAllByTestId("request")).toHaveLength(0);
  act(() => fake.add(record(1, {})));
  expect(view.queryAllByTestId("request")).toHaveLength(1);
});

test("the filter keeps the matching requests", () => {
  const { api } = fakeApi([
    record(1, { path: "/api/v2/person" }),
    record(2, { method: "POST", path: "/api/copilotkit" }),
  ]);
  const view = render(<RequestLog api={api} />);
  edit(view.getByLabelText("Filter"), "post");
  const rows = view.getAllByTestId("request");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.getAttribute("title")).toBe("POST /api/copilotkit");
});

test("a request with no answer says so and has the class", () => {
  const { api } = fakeApi([record(1, { source: "none", status: 404 })]);
  const view = render(<RequestLog api={api} />);
  const row = view.getByTestId("request");
  expect(row.textContent).toContain("No answer");
  expect(row.textContent).toContain("404");
  expect(row.className).toBe("wb-request-missing");
});

test("Answer this gives the route without the query", () => {
  const { api } = fakeApi([
    record(1, { path: "/api/v2/organizations/default/bots?page=2" }),
  ]);
  const onPick = mock();
  const view = render(<RequestLog api={api} onPick={onPick} />);
  fireEvent.click(view.getByText("Answer this"));
  expect(onPick).toHaveBeenCalledWith("GET /api/v2/organizations/default/bots");
});

test("without onPick there is no Answer this button", () => {
  const { api } = fakeApi([record(1, {})]);
  const view = render(<RequestLog api={api} />);
  expect(view.queryByText("Answer this")).toBeNull();
});
