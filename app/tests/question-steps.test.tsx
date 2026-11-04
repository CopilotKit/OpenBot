import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  QuestionNotice,
  useQuestionSteps,
  type WaitingQuestion,
} from "@/components/approvals/question-notice";
import { settleReactWork } from "./settle-react-work";

/**
 * A question of several decisions, answered one at a time in the composer's drawer: a pick or its
 * number settles one and shows the next, and the last sends them all as one answer, each on a line
 * under its label.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const question: WaitingQuestion = {
  id: "q1",
  botId: "assistant",
  threadId: "thread",
  channelId: "c1",
  question: "Three launch decisions",
  parts: [
    {
      header: "Tier name",
      question: "Which paid-tier name?",
      options: ["Pro", "Plus"],
    },
    {
      header: "Soar",
      question: "Is Soar in the launch?",
      options: ["Include", "Exclude"],
    },
    { header: "Thursday", question: "What is Thursday for?" },
  ],
  createdAt: "2026-11-04T10:00:00Z",
};

function Drawer({ onAnswered }: { onAnswered: (answer: string) => void }) {
  const steps = useQuestionSteps(question);
  return (
    <>
      <QuestionNotice
        avatarSeed="assistant"
        botName="Personal Assistant"
        onAnswered={onAnswered}
        question={question}
        steps={steps}
      />
      {/* What the composer does with a typed answer. */}
      <button
        onClick={() => {
          const whole = steps.answer("OpenBot 1.0 only");
          if (whole !== null) onAnswered(whole);
        }}
        type="button"
      >
        Send typed answer
      </button>
    </>
  );
}

function draw(onAnswered: (answer: string) => void) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Drawer onAnswered={onAnswered} />
    </QueryClientProvider>,
  );
}

test("each decision is answered in turn, and the last sends them all", async () => {
  const sent: string[] = [];
  const view = draw((answer) => sent.push(answer));

  expect(view.getByText("Which paid-tier name?")).toBeTruthy();
  expect(view.getByText("1/3")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: /Pro/ }));

  await view.findByText("Is Soar in the launch?");
  // Its number picks an option when nobody is typing.
  fireEvent.keyDown(document.body, { key: "2" });

  await view.findByText("What is Thursday for?");
  expect(view.getByText("Type your answer below.")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Send typed answer" }));

  await waitFor(() =>
    expect(sent).toEqual([
      "Tier name: Pro\nSoar: Exclude\nThursday: OpenBot 1.0 only",
    ]),
  );
});

test("an earlier decision can be gone back to, with its pick still shown", async () => {
  const view = draw(() => {});
  fireEvent.click(view.getByRole("button", { name: /Plus/ }));
  await view.findByText("Is Soar in the launch?");

  fireEvent.click(view.getByRole("button", { name: "Previous decision" }));

  await view.findByText("Which paid-tier name?");
  expect(
    view.getByRole("button", { name: /Plus/ }).getAttribute("aria-pressed"),
  ).toBe("true");
});
