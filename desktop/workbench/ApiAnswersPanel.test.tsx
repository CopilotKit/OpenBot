import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiAnswersPanel } from "./ApiAnswersPanel";
import type {
  ApiAnswer,
  ApiChange,
  ApiControl,
  ApiRecord,
  ApiRoute,
} from "./appContract";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const BOTS: ApiRoute = "GET /api/v2/organizations/:organizationId/bots";

function fakeApi(
  initial: [ApiRoute, ApiAnswer][] = [],
  requests: ApiRecord[] = [],
) {
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
    answerFor: () => null,
    requests: () => requests,
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

/** Opens the Mode list and picks the option with that name. */
async function pickMode(view: ReturnType<typeof render>, name: string) {
  const person = userEvent.setup({ document });
  await person.click(view.getByRole("combobox", { name: "Mode" }));
  await person.click(
    await within(document.body).findByRole("option", { name }),
  );
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

test("offline needs no body", async () => {
  const { api, setAnswer } = fakeApi();
  const onAnswer = mock();
  const view = render(
    <ApiAnswersPanel api={api} picked={BOTS} onAnswer={onAnswer} />,
  );
  await pickMode(view, "Offline");
  expect(view.queryByLabelText("Body (JSON)")).toBeNull();
  expect(view.queryByLabelText("Status")).toBeNull();
  fireEvent.click(view.getByText("Set answer"));
  expect(setAnswer).toHaveBeenCalledWith(BOTS, { mode: "offline" });
  expect(onAnswer).toHaveBeenCalledWith(BOTS, { mode: "offline" });
});

test("fail defaults to 422 and an empty body uses the default body", async () => {
  const { api, setAnswer } = fakeApi();
  const view = render(
    <ApiAnswersPanel api={api} picked={BOTS} onAnswer={() => {}} />,
  );
  await pickMode(view, "Fail");
  expect((view.getByLabelText("Status") as HTMLInputElement).value).toBe("422");
  edit(view.getByLabelText("Body (JSON)"), "");
  fireEvent.click(view.getByText("Set answer"));
  expect(setAnswer).toHaveBeenCalledWith(BOTS, { mode: "fail", status: 422 });
});

test("delay sends the milliseconds", async () => {
  const { api, setAnswer } = fakeApi();
  const view = render(
    <ApiAnswersPanel api={api} picked={BOTS} onAnswer={() => {}} />,
  );
  await pickMode(view, "Delay");
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

test("the modes are Value, Never, Fail, Delay and Offline", async () => {
  const { api } = fakeApi();
  const view = render(
    <ApiAnswersPanel api={api} picked={null} onAnswer={() => {}} />,
  );
  const trigger = view.getByRole("combobox", { name: "Mode" });
  expect(trigger.textContent).toContain("Value");
  await userEvent.setup({ document }).click(trigger);
  const options = await within(document.body).findAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual([
    "Value",
    "Never",
    "Fail",
    "Delay",
    "Offline",
  ]);
});

test("the Route list offers the routes the window asked for, and the set ones", async () => {
  const PERSON: ApiRoute = "GET /api/v2/person";
  const { api } = fakeApi(
    [[PERSON, { mode: "never" }]],
    [
      {
        id: 1,
        method: "GET",
        path: "/api/v2/organizations/default/bots",
        at: 0,
        source: "spec",
        route: BOTS,
        status: 200,
        state: "answered",
      },
    ],
  );
  const view = render(
    <ApiAnswersPanel api={api} picked={null} onAnswer={() => {}} />,
  );
  const person = userEvent.setup({ document });
  await person.click(view.getByLabelText("Route"));
  await person.keyboard("{ArrowDown}");
  const options = await within(document.body).findAllByRole("option");
  expect(options.map((o) => o.textContent).sort()).toEqual(
    [BOTS, PERSON].sort(),
  );
  await person.click(within(document.body).getByRole("option", { name: BOTS }));
  expect((view.getByLabelText("Route") as HTMLInputElement).value).toBe(BOTS);
});

test("a route that is not in the list stays as typed", async () => {
  const { api, setAnswer } = fakeApi();
  const view = render(
    <ApiAnswersPanel api={api} picked={null} onAnswer={() => {}} />,
  );
  const route = view.getByLabelText("Route") as HTMLInputElement;
  const person = userEvent.setup({ document });
  await person.click(route);
  await person.keyboard("POST /api/copilotkit");
  await person.click(view.getByText("Set answer"));
  expect(route.value).toBe("POST /api/copilotkit");
  expect(setAnswer).toHaveBeenCalledWith("POST /api/copilotkit", {
    mode: "value",
    status: 200,
    body: {},
  });
});
