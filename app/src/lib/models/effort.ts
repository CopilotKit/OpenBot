import type { ConversationModel, ModelCatalogue, ModelOption } from "./queries";

/**
 * The thinking effort a model runs at, beside the model itself.
 *
 * A pick is what the picker shows: always a model, because something always runs, and an effort
 * only where the person chose one. What is saved is the same pick with each default written as
 * null (`requestFor`), so a default follows the model and the provider rather than being pinned.
 */
export type ModelPick = { model: string; effort: string | null };

const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** An effort as a person reads it. One the list does not know is shown as given, capitalised. */
export function effortLabel(effort: string): string {
  return (
    EFFORT_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1)
  );
}

/** Whether a model takes an effort at all. One that does not shows no thinking control. */
export function thinks(model: ModelOption | undefined): boolean {
  return (model?.efforts?.length ?? 0) > 0;
}

/** Whether a model accepts this effort. Null, the model's own default, is never "accepted". */
export function accepts(
  model: ModelOption | undefined,
  effort: string | null,
): effort is string {
  return effort !== null && (model?.efforts?.includes(effort) ?? false);
}

/**
 * The effort to name beside a model: the one chosen, else the model's own default when its provider
 * says what that is. Undefined for a model that takes none, or whose default is unknown.
 */
export function shownEffort(
  model: ModelOption | undefined,
  effort: string | null,
): string | undefined {
  if (!thinks(model)) return undefined;
  if (accepts(model, effort)) return effort;
  return model?.defaultEffort;
}

/** Another model, keeping the effort when that model accepts it, else its own default. */
export function switchModel(pick: ModelPick, next: ModelOption): ModelPick {
  return {
    model: next.id,
    effort: accepts(next, pick.effort) ? pick.effort : null,
  };
}

function optionFor(
  catalogue: ModelCatalogue | undefined,
  id: string | null | undefined,
): ModelOption | undefined {
  return id ? catalogue?.models.find((model) => model.id === id) : undefined;
}

/**
 * What a picker shows for a saved pick: the saved model when the catalogue still offers it,
 * otherwise the default, and the saved effort only where that model accepts it.
 */
export function shownPick(
  saved: ConversationModel | null | undefined,
  catalogue: ModelCatalogue | undefined,
): ModelPick | undefined {
  if (!catalogue) return undefined;
  const option =
    optionFor(catalogue, saved?.model) ??
    optionFor(catalogue, catalogue.default);
  const model = option?.id ?? catalogue.default;
  const effort = saved?.effort ?? null;
  return { model, effort: accepts(option, effort) ? effort : null };
}

/**
 * What to save for a pick: null for the default model, and null for the model's own default effort
 * or one it does not accept, so the server is never asked for an effort it would refuse.
 */
export function requestFor(
  pick: ModelPick,
  catalogue: ModelCatalogue | undefined,
): ConversationModel {
  const option = optionFor(catalogue, pick.model);
  const effort =
    accepts(option, pick.effort) && pick.effort !== option?.defaultEffort
      ? pick.effort
      : null;
  return {
    model: pick.model === catalogue?.default ? null : pick.model,
    effort,
  };
}
