import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { CopilotKitProvider, useCopilotKit } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import {
  partsAnswer,
  QuestionNotice,
  type WaitingQuestion,
} from "@/components/approvals/question-notice";
import { EscalationTool } from "@/lib/copilot/escalation-tool";
import { PUT_TO } from "@/lib/copilot/markers";
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

/*
 * One decision is a question asked in parts too: a time zone, with the zones the Bot thinks
 * likely. The server used to refuse it, so nothing ever drew one; now the drawer and the step in
 * the transcript both have to read as a single question rather than a questionnaire of one.
 */
const timeZone = {
  header: "Time zone",
  question: "Which time zone should the event use?",
  options: ["Europe/London", "America/New_York"],
};

test("a question of one decision is answered as one question, with its options", async () => {
  const sent: string[] = [];
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <QuestionNotice
        avatarSeed="assistant"
        botName="Personal Assistant"
        onAnswered={async (answer) => {
          sent.push(answer);
        }}
        question={{
          ...question,
          question: "Which time zone should the event use?",
          parts: [timeZone],
        }}
      />
    </QueryClientProvider>,
  );

  // No "Question 1 of 1", no Next: one answer to give and one to send.
  expect(view.queryByText("Question 1 of 1")).toBeNull();
  expect(view.queryByRole("button", { name: "Send answers" })).toBeNull();
  fireEvent.click(view.getByRole("radio", { name: /Europe\/London/ }));
  fireEvent.click(view.getByRole("button", { name: "Send answer" }));

  await waitFor(() => expect(sent).toEqual(["Time zone: Europe/London"]));
});

type Renderer = ComponentType<Record<string, unknown>>;

/** The `ask_person` step as the transcript draws it, through the SDK's own registry. */
async function askedStep(args: Record<string, unknown>, result: string) {
  let copilotkit: ReturnType<typeof useCopilotKit>["copilotkit"] | undefined;
  function Capture() {
    copilotkit = useCopilotKit().copilotkit;
    return null;
  }
  const renderer = () =>
    copilotkit?.renderToolCalls.find(
      (candidate) => candidate.name === "ask_person",
    )?.render as Renderer | undefined;
  const tree = render(
    <CopilotKitProvider>
      <EscalationTool />
      <Capture />
    </CopilotKitProvider>,
  );
  await waitFor(() => expect(renderer()).toBeDefined());
  const Step = renderer() as Renderer;
  tree.rerender(
    <CopilotKitProvider>
      <EscalationTool />
      <Capture />
      <Step
        args={args}
        name="ask_person"
        result={result}
        status="complete"
        toolCallId="call-ask"
      />
    </CopilotKitProvider>,
  );
  return tree;
}

test("a question of one decision reads as asked, and is not numbered as if more were missing", async () => {
  // The answer the server gives once the question has been put to somebody, JSON-encoded as a
  // server tool's result arrives.
  const view = await askedStep(
    { question: "Which time zone should the event use?", parts: [timeZone] },
    JSON.stringify(
      `${PUT_TO}the person in the source conversation; the question is saved awaiting their reply.`,
    ),
  );

  await view.findByText("Asked you");
  expect(view.queryByText(/Blocked/)).toBeNull();
  const list = view.getByRole("list");
  expect(list.className).not.toContain("list-decimal");
  expect(view.getByRole("listitem").textContent).toBe(
    "Time zone: Which time zone should the event use? (Europe/London, America/New_York)",
  );
});

test("several decisions are still numbered", async () => {
  const view = await askedStep(
    { question: "Two launch decisions", parts },
    JSON.stringify(`${PUT_TO}the person in this conversation.`),
  );

  await view.findByText("Asked you");
  expect(view.getByRole("list").className).toContain("list-decimal");
  expect(view.getAllByRole("listitem")).toHaveLength(2);
});
