import type { SavedModelSelection } from "@openbot/shared/conversation-model";
import type { RuntimeModel } from "../copilot";

export type {
  ConversationModel,
  SavedModelSelection,
} from "@openbot/shared/conversation-model";
export class ModelSelectionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 503,
  ) {
    super(message);
  }
}
export const unavailableModel =
  "This model isn't available. Choose another model.";
// Reviewed 2026-10-28 against developers.openai.com/api/docs/models and
// platform.claude.com/docs/en/models/overview. Protocol/tool-loop coverage lives in copilot.test.ts.
// Haiku 5.5 uses the existing adapter's 128K compatibility cap, matching its documented limit.
const candidates = {
  openai: [
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
    { id: "gpt-6-luna", label: "GPT-6 Luna" },
  ],
  anthropic: [
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  ],
};
const defaultLabels: Record<string, string> = {
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.5": "GPT-5.5",
};
export function modelOptions(base: RuntimeModel, allowed?: readonly string[]) {
  return [
    ...new Map(
      [
        ...candidates[base.provider],
        {
          id: base.defaultModel,
          label:
            candidates[base.provider].find((m) => m.id === base.defaultModel)
              ?.label ??
            defaultLabels[base.defaultModel] ??
            base.defaultModel,
        },
      ].map((m) => [m.id, m]),
    ).values(),
  ].filter((m) => !allowed || allowed.includes(`${base.provider}/${m.id}`));
}
export function directModelConnection(
  base: RuntimeModel,
  apiKey: string | null,
  environment: Record<string, string | undefined> = process.env,
) {
  const url = environment[
    base.provider === "openai" ? "OPENAI_BASE_URL" : "ANTHROPIC_BASE_URL"
  ]
    ?.trim()
    .replace(/\/+$/, "");
  const official =
    base.provider === "openai"
      ? "https://api.openai.com/v1"
      : "https://api.anthropic.com/v1";
  return !base.plan && !!apiKey && (!url || url === official);
}
export function resolveChoice(
  base: RuntimeModel,
  saved: SavedModelSelection | null,
  options: readonly string[],
): RuntimeModel {
  if (!saved) return base;
  if (
    base.plan ||
    saved.provider !== base.provider ||
    !options.includes(saved.model)
  )
    throw new ModelSelectionError(unavailableModel, 409);
  return { ...base, defaultModel: saved.model };
}
