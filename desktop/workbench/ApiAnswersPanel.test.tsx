import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ApiAnswersPanel } from "./ApiAnswersPanel";
import type { ApiAnswer, ApiChange, ApiControl, ApiRoute } from "./appContract";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const BOTS: ApiRoute = "GET /api/v2/organizations/:organizationId/bots";

function fakeApi(initial: [ApiRoute, ApiAnswer][] = []) {
  const map = new Map<ApiRoute, ApiAnswer>(initial);
  const listeners = new Set<(change: ApiChange) => void>();
  const notify = (route: ApiRoute) => {
    for (const listener of listeners) listener({ kind: "answer", route });
  };
  const setAnswer = mock((route: ApiRoute, answer: ApiAnswer) => {
    map.delete(route);
    map.set(route, answer);
    notify(route);
  });
  const clearAnswer = mock((route: ApiRoute) => {
    map.delete(route);
    notify(route);
  });
  const api: ApiControl = {
    setAnswer,
    clearAnswer,
    answers: () => new Map(map),
    requests: () => [],
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { api, setAnswer, clearAnswer };
}

function edit(el: HTMLElement, value: string) {
  fireEvent.focusIn(el);
  fireEvent.change(el, { target: { value } });
  fireEvent.keyUp(el);
}

test("a value answer reaches the API and onAnswer", () => {
  const { api, setAnswer } = fakeApi();
  const onAnswer = mock();
  const view = render(
    <ApiAnswersPanel api={api} picked={null} onAnswer={onAnswer} />,
  );
  edit(view.getByLabelText("Route"), BOTS);
  edit(view.getByLabelText("Status"), "201");
  edit(view.getByLabelText("Body (JSON)"), '{"items":[]}');
  fireEvent.click(view.getByText("Set answer"));
  const answer = { mode: "value", status: 201, body: { items: [] } };
  expect(setAnswer).toHaveBeenCalledWith(BOTS, answer);
  expect(onAnswer).toHaveBeenCalledWith(BOTS, answer);
  expect(view.getAllByTestId("api-answer")).toHaveLength(1);
  expect(view.getByTestId("api-answer").textContent).toContain(BOTS);
  expect(view.getByTestId("api-answer").textContent).toContain("Value");
});

test("the route comes from picked", () => {
  const { api } = fakeApi();
  const view = render(
    <ApiAnswersPanel api={api} picked={null} onAnswer={() => {}} />,
  );
  view.rerender(
    <ApiAnswersPanel api={api} picked={BOTS} onAnswer={() => {}} />,
  );
  expect((view.getByLabelText("Route") as HTMLInputElement).value).toBe(BOTS);
});

test("bad JSON shows the error and calls nothing", () => {
  const { api, setAnswer } = fakeApi();
  const onAnswer = mock();
  const view = render(
    <ApiAnswersPanel api={api} picked={BOTS} onAnswer={onAnswer} />,
  );
  edit(view.getByLabelText("Body (JSON)"), "{nope");
  fireEvent.click(view.getByText("Set answer"));
  expect(view.getByRole("alert").textContent).toBe(
    "The body is not valid JSON.",
  );
  expect(setAnswer).not.toHaveBeenCalled();
  expect(onAnswer).not.toHaveBeenCalled();
});

test("a bad route shows the error and calls nothing", () => {
  const { api, setAnswer } = fakeApi();
  const view = render(
    <ApiAnswersPanel api={api} picked={null} onAnswer={() => {}} />,
  );
  edit(view.getByLabelText("Route"), "GET /bots");
  fireEvent.click(view.getByText("Set answer"));
  expect(view.getByRole("alert").textContent).toBe(
    "Write a method and a path, for example GET /api/v2/organizations/:organizationId/bots.",
  );
  expect(setAnswer).not.toHaveBeenCalled();
});

test("offline needs no body", () => {
  const { api, setAnswer } = fakeApi();
  const onAnswer = mock();
  const view = render(
    <ApiAnswersPanel api={api} picked={BOTS} onAnswer={onAnswer} />,
  );
  edit(view.getByLabelText("Mode"), "offline");
  expect(view.queryByLabelText("Body (JSON)")).toBeNull();
  expect(view.queryByLabelText("Status")).toBeNull();
  fireEvent.click(view.getByText("Set answer"));
  expect(setAnswer).toHaveBeenCalledWith(BOTS, { mode: "offline" });
  expect(onAnswer).toHaveBeenCalledWith(BOTS, { mode: "offline" });
});

test("fail defaults to 422 and an empty body uses the default body", () => {
  const { api, setAnswer } = fakeApi();
  const view = render(
    <ApiAnswersPanel api={api} picked={BOTS} onAnswer={() => {}} />,
  );
  edit(view.getByLabelText("Mode"), "fail");
  expect((view.getByLabelText("Status") as HTMLInputElement).value).toBe("422");
  edit(view.getByLabelText("Body (JSON)"), "");
  fireEvent.click(view.getByText("Set answer"));
  expect(setAnswer).toHaveBeenCalledWith(BOTS, { mode: "fail", status: 422 });
});

test("delay sends the milliseconds", () => {
  const { api, setAnswer } = fakeApi();
  const view = render(
    <ApiAnswersPanel api={api} picked={BOTS} onAnswer={() => {}} />,
  );
  edit(view.getByLabelText("Mode"), "delay");
  edit(view.getByLabelText("Delay in ms"), "500");
  fireEvent.click(view.getByText("Set answer"));
  expect(setAnswer).toHaveBeenCalledWith(BOTS, {
    mode: "delay",
    ms: 500,
    status: 200,
    body: {},
  });
});

test("Clear in the list calls clearAnswer and onAnswer with null", () => {
  const { api, clearAnswer } = fakeApi([[BOTS, { mode: "never" }]]);
  const onAnswer = mock();
  const view = render(
    <ApiAnswersPanel api={api} picked={null} onAnswer={onAnswer} />,
  );
  expect(view.getByTestId("api-answer").textContent).toContain("Never");
  fireEvent.click(view.getByLabelText(`Clear ${BOTS}`));
  expect(clearAnswer).toHaveBeenCalledWith(BOTS);
  expect(onAnswer).toHaveBeenCalledWith(BOTS, null);
  expect(view.queryAllByTestId("api-answer")).toHaveLength(0);
});
