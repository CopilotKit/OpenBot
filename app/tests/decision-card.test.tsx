import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  type DecisionAnswer,
  DecisionCard,
  OTHER,
} from "@/components/decisions/decision-card";
import { settleReactWork } from "./settle-react-work";

/**
 * The card a Bot's question and every approval are drawn in: rows with what each does, the first
 * picked, one button named for the pick, 1 to 9 and Enter on the newest waiting card, and a fold
 * into the answer once given.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const OPTIONS = [
  { value: "staging", label: "Staging", description: "Safe, and reversible" },
  { value: "production", label: "Production", description: "Live customers" },
];

function card(
  sent: [string, string][],
  props: { title?: string; answer?: DecisionAnswer; other?: boolean } = {},
) {
  return (
    <DecisionCard
      {...(props.answer ? { answer: props.answer } : {})}
      onSubmit={(value, text) => {
        sent.push([value, text]);
      }}
      options={OPTIONS}
      {...(props.other
        ? { other: { placeholder: "Answer something else…" } }
        : {})}
      title={props.title ?? "Which environment?"}
    />
  );
}

test("each answer is a row with what it does, the first is picked, and the button says it", () => {
  const view = render(card([]));
  const staging = view.getByRole("radio", { name: "Staging" });
  expect((staging as HTMLInputElement).checked).toBe(true);
  expect(staging.getAttribute("aria-describedby")).toBeTruthy();
  expect(view.getByText("Live customers")).toBeTruthy();
  expect(view.getByRole("button", { name: "Staging" })).toBeTruthy();
  expect(view.getByText("Waiting on you")).toBeTruthy();
});

test("a number picks its row and Enter sends it", async () => {
  const sent: [string, string][] = [];
  const view = render(card(sent));
  const user = userEvent.setup({ document });
  await user.keyboard("2");
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Production" })).toBeTruthy(),
  );
  await user.keyboard("{Enter}");
  expect(sent).toEqual([["production", ""]]);
});

test("only the newest waiting card takes the keys", async () => {
  const first: [string, string][] = [];
  const second: [string, string][] = [];
  const view = render(
    <>
      {card(first, { title: "First" })}
      {card(second, { title: "Second" })}
    </>,
  );
  const user = userEvent.setup({ document });
  await user.keyboard("2");
  await user.keyboard("{Enter}");
  expect(first).toEqual([]);
  expect(second).toEqual([["production", ""]]);
  expect(
    (
      within(view.getByRole("group", { name: "First" })).getByRole("radio", {
        name: "Staging",
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
});

test("typing elsewhere never picks or sends", async () => {
  const sent: [string, string][] = [];
  const view = render(
    <>
      <textarea aria-label="Message" />
      {card(sent)}
    </>,
  );
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("textbox", { name: "Message" }));
  await user.keyboard("2{Enter}");
  expect(sent).toEqual([]);
  expect(view.getByRole("button", { name: "Staging" })).toBeTruthy();
});

test("the last row takes words instead, and Enter in it sends them", async () => {
  const sent: [string, string][] = [];
  const view = render(card(sent, { other: true }));
  const user = userEvent.setup({ document });
  await user.type(
    view.getByRole("textbox", { name: "Your answer" }),
    "Neither, wait for Monday{Enter}",
  );
  expect(sent).toEqual([[OTHER, "Neither, wait for Monday"]]);
});

test("the words row needs words before it can be sent", async () => {
  const sent: [string, string][] = [];
  const view = render(card(sent, { other: true }));
  const user = userEvent.setup({ document });
  await user.keyboard("3");
  const button = await view.findByRole("button", { name: "Send" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
});

test("answered, it folds into one line with the answer, and takes no keys", async () => {
  const sent: [string, string][] = [];
  const view = render(
    card(sent, {
      answer: { label: "Answered", choice: "Production", tone: "positive" },
    }),
  );
  expect(view.queryByRole("radio")).toBeNull();
  expect(view.getByText("Answered")).toBeTruthy();
  expect(view.getByText("Production")).toBeTruthy();
  const user = userEvent.setup({ document });
  await user.keyboard("1{Enter}");
  expect(sent).toEqual([]);
});
