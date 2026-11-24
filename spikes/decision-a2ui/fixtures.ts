import type { Decisions } from "@google/genai";
import type {
  ActionMessage,
  Application,
  SubmitDecisions,
} from "./decision.ts";

export const application: Application = {
  settings: {
    title: "Settings",
    nameLabel: "Display name",
    name: "Ada",
    notifyLabel: "Email updates",
    notify: true,
  },
  results: {
    title: "Search results",
    items: [
      {
        id: "alder",
        title: "Alder",
        summary: "Alder — waitlist",
        detail: "Alder has a waitlist of two.",
      },
      {
        id: "birch",
        title: "Birch",
        summary: "Birch — available",
        detail: "Birch has three openings this month.",
      },
      {
        id: "cedar",
        title: "Cedar",
        summary: "Cedar — full",
        detail: "Cedar has no openings this month.",
      },
    ],
  },
  confirmation: {
    title: "Confirm booking",
    detail: "Reserve one place in Birch.",
    label: "Confirm",
  },
};

type Answers = Record<string, string | { choice: string; confidence: number }>;
export type Example = {
  id: string;
  request: string;
  answers: Answers;
  components?: Record<string, string>;
  error?: string;
};

export const cases: Example[] = [
  {
    id: "settings-stack",
    request:
      "Show settings as a vertical form with display name and an email updates checkbox.",
    answers: { layout: "settings", settingsGroup: "Column" },
    components: {
      settings_group: "Column",
      name: "TextField",
      notify: "CheckBox",
    },
  },
  {
    id: "settings-row",
    request:
      "Show a settings form with the editable display name and email notifications checkbox side by side.",
    answers: { layout: "settings", settingsGroup: "Row" },
    components: {
      settings_group: "Row",
      name: "TextField",
      notify: "CheckBox",
    },
  },
  {
    id: "results-nested",
    request:
      "Show all results as a scrollable selectable list, with a card for the selected result’s short status.",
    answers: { layout: "results", resultsGroup: "List", detailFrame: "Card" },
    components: {
      results_group: "List",
      detail_frame: "Card",
      result_birch: "Button",
      detail: "Text",
    },
  },
  {
    id: "results-plain",
    request:
      "Stack all result choices in the page, with the selected result’s full detail as plain text.",
    answers: {
      layout: "results",
      resultsGroup: "Column",
      detailFrame: "inline",
    },
    components: {
      results_group: "Column",
      result_cedar: "Button",
      detail: "Text",
    },
  },
  {
    id: "confirmation",
    request:
      "Put the booking confirmation in a card with one primary confirm button.",
    answers: { layout: "confirmation", confirmationFrame: "Card" },
    components: {
      confirm_frame: "Card",
      confirm_group: "Column",
      confirm: "Button",
    },
  },
  {
    id: "ambiguous",
    request: "Make it better.",
    answers: { layout: "other" },
    error: "scope",
  },
  {
    id: "unsupported",
    request: "Create an editable calendar grid with drag-and-drop time slots.",
    answers: { layout: "other" },
    error: "scope",
  },
  { id: "missing", request: "Show settings.", answers: {}, error: "answer" },
  {
    id: "malformed",
    request: "Show settings.",
    answers: { layout: "arbitrary_component" },
    error: "answer",
  },
  {
    id: "low-confidence",
    request: "Show either settings or results, depending on what seems nice.",
    answers: { layout: { choice: "settings", confidence: 0.55 } },
    error: "confidence",
  },
  {
    id: "missing-selected-branch",
    request: "Show settings.",
    answers: { layout: "settings" },
    error: "answer",
  },
];

export function actionFor(id: string): ActionMessage {
  return {
    version: "1.0",
    action: {
      name: "choose_result",
      surfaceId: "spike",
      sourceComponentId: `result_${id}`,
      timestamp: "2026-11-19T00:00:00.000Z",
      context: { id },
    },
  };
}

export function mockDecisions(...turns: Answers[]) {
  const requests: Decisions.CreateDecisionRequest[] = [];
  const submit: SubmitDecisions = async (request) => {
    const fixture = turns[requests.length];
    requests.push(request);
    if (!fixture) throw new Error("Unexpected decision request");
    const answers: Record<string, Decisions.ChoiceAnswer> = {};
    for (const [id, raw] of Object.entries(fixture)) {
      const question = request.questions[id];
      if (question?.type !== "choice") continue;
      const { choice, confidence } =
        typeof raw === "string" ? { choice: raw, confidence: 0.95 } : raw;
      const options = Object.keys(question.criteria);
      answers[id] = {
        type: "choice",
        choice,
        confidence,
        probabilities: Object.fromEntries(
          options.map((key) => [
            key,
            key === choice
              ? confidence
              : (1 - confidence) / (options.length - 1),
          ]),
        ),
      };
    }
    return { answers };
  };
  return { requests, submit };
}
