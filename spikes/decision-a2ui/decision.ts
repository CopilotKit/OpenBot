import type { A2uiRequestProcessor } from "@a2ui/agent";
import type { Decisions } from "@google/genai";
import {
  ActionMessageSchema,
  type ActionMessage,
  type AgentToRendererMessage,
  type CatalogApi,
  type DataBinding,
} from "@a2ui/web_core/v1_0";
import { acceptMessages, surfaceId } from "./sdk.ts";

export const decisionModel = "gemini-decision-1";
const minConfidence = 0.7;

export type SubmitDecisions = (
  request: Decisions.CreateDecisionRequest,
) => Promise<Decisions.CreateDecisionResponse>;
export type Family = "settings" | "results" | "confirmation";
export type Application = {
  settings: {
    title: string;
    nameLabel: string;
    name: string;
    notifyLabel: string;
    notify: boolean;
  };
  results: {
    title: string;
    items: { id: string; title: string; summary: string; detail: string }[];
  };
  confirmation: { title: string; detail: string; label: string };
};
type Component = { id: string; component: string } & Record<string, unknown>;
type Choices = Record<string, string>;
type Questions = Record<string, Decisions.ChoiceQuestion>;
type Plan = { questions: Questions; fixed: Record<string, string> };

export class DecisionError extends Error {
  readonly code: "scope" | "confidence" | "answer" | "action" | "state";

  constructor(code: DecisionError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

function addChoice(
  plan: Plan,
  id: string,
  instructions: string,
  criteria: Choices,
) {
  const options = Object.keys(criteria);
  if (!options.length)
    throw new DecisionError("scope", `Catalog has no candidates for ${id}`);
  if (options.length === 1) plan.fixed[id] = options[0];
  else plan.questions[id] = { type: "choice", instructions, criteria };
}

function promptPlan(catalog: CatalogApi, app: Application): Plan {
  const plan: Plan = { questions: {}, fixed: {} };
  const supports = (...names: string[]) =>
    names.every((name) => catalog.components.has(name));
  if (!supports("Column", "Text"))
    throw new DecisionError("scope", "Column and Text are required");

  const layouts: Choices = {
    other:
      'A vague request such as "make it better", or a different task such as an editable calendar, scheduling or drag-and-drop.',
  };
  if (supports("TextField", "CheckBox")) {
    layouts.settings =
      "Preferences or settings for display name and email notifications. The form can stack controls or place them side by side.";
    addChoice(
      plan,
      "settingsGroup",
      "For a settings form, pick how to arrange its controls.",
      {
        Column: "Stack entries vertically. Use for a regular settings page.",
        ...(supports("Row")
          ? { Row: "Arrange controls side by side, when requested." }
          : {}),
      },
    );
  }
  if (supports("Button") && app.results.items.length) {
    layouts.results =
      "View or browse search results and choose an item to see its status or description. Results can be stacked or scrollable, with plain or framed details.";
    addChoice(
      plan,
      "resultsGroup",
      "For the results list, choose the result collection component.",
      {
        Column: "Simple stacked choices without independent scrolling.",
        ...(supports("List")
          ? { List: "A list container for a scrollable collection of choices." }
          : {}),
      },
    );
    addChoice(
      plan,
      "detailFrame",
      "For a results page, should the detail be visually framed?",
      {
        inline: "Detail text directly in the page.",
        ...(supports("Card") ? { Card: "Put the detail inside a card." } : {}),
      },
    );
  }
  if (supports("Button")) {
    layouts.confirmation =
      "A booking confirmation screen with one primary confirmation action, in a plain page or a card.";
    addChoice(
      plan,
      "confirmationFrame",
      "For a confirmation, how should copy and action be presented?",
      {
        inline: "Show the copy and primary action in a plain page.",
        ...(supports("Card")
          ? { Card: "Show the copy and primary action in one card." }
          : {}),
      },
    );
  }
  addChoice(
    plan,
    "layout",
    "Which UI task is the request asking for? Use the request to determine intent. The app data is a reference containing fixtures for every potential task.",
    layouts,
  );
  return plan;
}

function choose(
  plan: Plan,
  result: Decisions.CreateDecisionResponse,
  id: string,
): string {
  if (Object.hasOwn(plan.fixed, id)) return plan.fixed[id];
  const criteria = plan.questions[id]?.criteria;
  const answer = result?.answers?.[id];
  if (
    answer?.type !== "choice" ||
    typeof answer.choice !== "string" ||
    !criteria ||
    !Object.hasOwn(criteria, answer.choice) ||
    !Number.isFinite(answer.confidence) ||
    answer.confidence < 0 ||
    answer.confidence > 1
  ) {
    throw new DecisionError("answer", `Missing or malformed decision: ${id}`);
  }
  const probabilities = answer.probabilities;
  const winner = probabilities?.[answer.choice];
  if (
    !probabilities ||
    typeof winner !== "number" ||
    !Object.hasOwn(probabilities, answer.choice) ||
    Object.keys(probabilities).length !== Object.keys(criteria).length ||
    !Object.keys(criteria).every(
      (key) =>
        Object.hasOwn(probabilities, key) &&
        Number.isFinite(probabilities[key]) &&
        probabilities[key] >= 0 &&
        probabilities[key] <= winner,
    ) ||
    Math.abs(Object.values(probabilities).reduce((sum, p) => sum + p, 0) - 1) >
      0.01 ||
    Math.abs(winner - answer.confidence) > 0.01
  ) {
    throw new DecisionError(
      "answer",
      `Malformed decision probabilities: ${id}`,
    );
  }
  if (answer.confidence < minConfidence)
    throw new DecisionError("confidence", `Low confidence: ${id}`);
  if (answer.choice === "other")
    throw new DecisionError("scope", "No supported answer fits the request");
  return answer.choice;
}

const text = (id: string, value: string | DataBinding): Component => ({
  id,
  component: "Text",
  text: value,
});
const binding = (name: string): DataBinding => ({ "@path": `/${name}` });
const group = (
  id: string,
  component: string,
  children: string[],
): Component => ({ id, component, children });
const card = (id: string, child: string): Component => ({
  id,
  component: "Card",
  child,
});

function button(
  id: string,
  label: string,
  name: string,
  context: Record<string, string>,
  primary = false,
): Component[] {
  const child = `label_${id}`;
  return [
    text(child, label),
    {
      id,
      component: "Button",
      child,
      variant: primary ? "primary" : "default",
      action: { event: { name, context } },
    },
  ];
}

function compile(
  catalog: CatalogApi,
  plan: Plan,
  result: Decisions.CreateDecisionResponse,
  app: Application,
): { family: Family; messages: AgentToRendererMessage[] } {
  const family = choose(plan, result, "layout");
  let components: Component[];
  let data: Record<string, unknown>;
  switch (family) {
    case "settings": {
      const settings = app.settings;
      components = [
        group("root", "Column", ["title", "settings_group"]),
        text("title", settings.title),
        group("settings_group", choose(plan, result, "settingsGroup"), [
          "name",
          "notify",
        ]),
        {
          id: "name",
          component: "TextField",
          label: settings.nameLabel,
          value: binding("name"),
        },
        {
          id: "notify",
          component: "CheckBox",
          label: settings.notifyLabel,
          value: binding("notify"),
        },
      ];
      data = { name: settings.name, notify: settings.notify };
      break;
    }
    case "results": {
      const results = app.results;
      const framed = choose(plan, result, "detailFrame") === "Card";
      components = [
        group("root", "Column", [
          "title",
          "results_group",
          framed ? "detail_frame" : "detail",
        ]),
        text("title", results.title),
        group(
          "results_group",
          choose(plan, result, "resultsGroup"),
          results.items.map((item) => `result_${item.id}`),
        ),
        ...results.items.flatMap((item) =>
          button(`result_${item.id}`, item.title, "choose_result", {
            id: item.id,
          }),
        ),
        ...(framed ? [card("detail_frame", "detail")] : []),
        text("detail", binding("detail")),
      ];
      data = {
        selectedId: null,
        detail: "Select a result to see its details.",
      };
      break;
    }
    case "confirmation": {
      const confirmation = app.confirmation;
      const framed = choose(plan, result, "confirmationFrame") === "Card";
      const children = ["title", "detail", "confirm"];
      components = [
        group("root", "Column", framed ? ["confirm_frame"] : children),
        ...(framed
          ? [
              card("confirm_frame", "confirm_group"),
              group("confirm_group", "Column", children),
            ]
          : []),
        text("title", confirmation.title),
        text("detail", binding("detail")),
        ...button("confirm", confirmation.label, "confirm_request", {}, true),
      ];
      data = { detail: confirmation.detail };
      break;
    }
    default:
      throw new DecisionError("answer", "No compiler for the chosen layout");
  }

  return {
    family,
    messages: [
      { version: "1.0", createSurface: { surfaceId, catalogId: catalog.id } },
      { version: "1.0", updateComponents: { surfaceId, components } },
      { version: "1.0", updateDataModel: { surfaceId, value: data } },
    ],
  };
}

export class DecisionSession {
  readonly state: NonNullable<A2uiRequestProcessor["state"]>;
  private current?: { request: string; family: Family; app: Application };
  private history: { name: string; selectedId?: string; mode: string }[] = [];
  private busy = false;
  private readonly processor: A2uiRequestProcessor;
  private readonly submit: SubmitDecisions;

  constructor(processor: A2uiRequestProcessor, submit: SubmitDecisions) {
    this.processor = processor;
    this.submit = submit;
    this.state = processor.state ?? processor.createState();
  }

  async show(request: string, application: Application) {
    return this.oneTurn(async () => {
      if (this.current || this.state.getSurface(surfaceId))
        throw new DecisionError("state", "Initial surface already exists");
      const app = structuredClone(application);
      const ids = app.results.items.map((item) => item.id);
      if (
        !request.trim() ||
        request.length > 2000 ||
        ids.length > 8 ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !/^[a-z][a-z0-9_]{0,31}$/.test(id))
      ) {
        throw new DecisionError(
          "scope",
          "Request or application data is outside the spike bounds",
        );
      }
      const catalog = this.processor.catalogs[0];
      const plan = promptPlan(catalog, app);
      const started = performance.now();
      const result = await this.ask(plan, {
        request,
        app,
        catalogId: catalog.id,
        currentState: null,
        interactionHistory: [],
      });
      const apiMs = performance.now() - started;
      const compiled = compile(catalog, plan, result, app);
      const messages = acceptMessages(
        this.processor,
        this.state,
        compiled.messages,
      );
      this.current = { request, app, family: compiled.family };
      return { messages, apiMs, usage: result.usage };
    });
  }

  async follow(raw: unknown) {
    return this.oneTurn(async () => {
      const parsed = ActionMessageSchema.safeParse(raw);
      const current = this.current;
      if (!parsed.success || !current || !this.state.getSurface(surfaceId)) {
        throw new DecisionError(
          "action",
          "Expected an action on an existing spike surface",
        );
      }
      const { action } = parsed.data;
      const item = current.app.results.items.find(
        (item) => item.id === action.context.id,
      );
      const select =
        current.family === "results" &&
        action.name === "choose_result" &&
        item &&
        action.sourceComponentId === `result_${item.id}`;
      const confirm =
        current.family === "confirmation" &&
        action.name === "confirm_request" &&
        action.sourceComponentId === "confirm";
      const surface = this.state.getSurface(surfaceId);
      if (
        action.surfaceId !== surfaceId ||
        (!select && !confirm) ||
        !surface?.componentsModel.get(action.sourceComponentId)
      ) {
        throw new DecisionError("action", "Unknown action or source component");
      }

      const plan: Plan = { questions: {}, fixed: {} };
      addChoice(
        plan,
        "detailMode",
        select
          ? "Which view of this selected result matches the request?"
          : "What does the explicit confirmation click mean?",
        select
          ? {
              detail: "Show the full application-supplied description.",
              summary: "Show only the short status summary.",
              other: "The available detail does not address the request.",
            }
          : {
              acknowledged:
                "The user explicitly clicked the confirmation button.",
              other: "The confirmation should not be acknowledged.",
            },
      );
      const started = performance.now();
      const result = await this.ask(plan, {
        request: current.request,
        family: current.family,
        selectedItem: select ? item : undefined,
        action: {
          name: action.name,
          sourceComponentId: action.sourceComponentId,
        },
        currentState: {
          surfaceId,
          selectedId: surface.dataModel.get("/selectedId"),
          detail: surface.dataModel.get("/detail"),
        },
        interactionHistory: this.history,
      });
      const apiMs = performance.now() - started;
      const mode = choose(plan, result, "detailMode");
      const selectedId = select ? item.id : undefined;
      const detail = select
        ? mode === "summary"
          ? item.summary
          : item.detail
        : "Confirmed.";
      const messages = acceptMessages(this.processor, this.state, [
        {
          version: "1.0",
          updateDataModel: {
            surfaceId,
            value: select ? { selectedId, detail } : { detail },
          },
        },
      ]);
      this.history = [
        ...this.history.slice(-7),
        { name: action.name, selectedId, mode },
      ];
      return { messages, apiMs, usage: result.usage };
    });
  }

  private async ask(
    plan: Plan,
    input: object,
  ): Promise<Decisions.CreateDecisionResponse> {
    if (!Object.keys(plan.questions).length)
      throw new DecisionError("scope", "No supported decision questions");
    return this.submit({
      model: decisionModel,
      input: JSON.stringify(input),
      questions: plan.questions,
    });
  }

  private async oneTurn<T>(run: () => Promise<T>): Promise<T> {
    if (this.busy)
      throw new DecisionError("state", "A turn is already running");
    this.busy = true;
    try {
      return await run();
    } finally {
      this.busy = false;
    }
  }
}

export type { ActionMessage };
