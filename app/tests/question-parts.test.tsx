import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  partsAnswer,
  QuestionNotice,
  type WaitingQuestion,
} from "@/components/approvals/question-notice";
import { settleReactWork } from "./settle-react-work";

/**
 * A question of several decisions, answered in the composer's drawer as a questionnaire: one
 * decision at a time, an option or the person's own words for each, and one answer sent at the end
 * with a line per decision under its label.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const parts = [
  {
    header: "Tier name",
    question: "Which paid-tier name?",
    options: ["Pro", "Plus"],
  },
  { header: "Thursday", question: "What is Thursday for?" },
];

const question: WaitingQuestion = {
  id: "q1",
  botId: "assistant",
  threadId: "thread",
  channelId: "c1",
  question: "Two launch decisions",
  parts,
  createdAt: "2026-11-04T10:00:00Z",
};

test("the whole answer is a line per decision: the option, the words, or both", () => {
  const form = new FormData();
  form.append("part-0", "Pro");
  form.append("part-0", " but only for teams ");
  form.append("part-1", "OpenBot 1.0 only");
  expect(partsAnswer(parts, form)).toBe(
    "Tier name: Pro, but only for teams\nThursday: OpenBot 1.0 only",
  );
});

test("each decision is shown in turn, and the last sends them all as one answer", async () => {
  const sent: string[] = [];
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <QuestionNotice
        avatarSeed="assistant"
        botName="Personal Assistant"
        onAnswered={async (answer) => {
          sent.push(answer);
        }}
        question={question}
      />
    </QueryClientProvider>,
  );

  expect(view.getByText("Question 1 of 2")).toBeTruthy();
  fireEvent.click(view.getByRole("radio", { name: /Pro/ }));
  fireEvent.click(view.getByRole("button", { name: "Next" }));

  await view.findByText("Question 2 of 2");
  await userEvent.type(
    view.getByRole("textbox", { name: "Thursday, in your own words" }),
    "OpenBot 1.0 only",
  );
  fireEvent.click(view.getByRole("button", { name: "Send answers" }));

  await waitFor(() =>
    expect(sent).toEqual(["Tier name: Pro\nThursday: OpenBot 1.0 only"]),
  );
});
