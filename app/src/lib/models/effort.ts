import type { AgentProfile } from "@/lib/agents/queries";
import { catalogueFor, connectionOf, pickerGroups } from "./connections";
import type {
  ConversationModel,
  ConversationModelInput,
  ModelCatalogue,
  ModelOption,
} from "./queries";

/**
 * The thinking effort a model runs at, beside the model itself.
 *
 * A pick is what the picker shows: always a model, because something always runs, and an effort
 * only where the person chose one. What is saved is the same pick with each default written as
 * null (`requestFor`), so a default follows the model and the provider rather than being pinned.
 */
export type ModelPick = {
  model: string;
  effort: string | null;
  /**
   * The AI connection the model is on, where several are connected (catalogue `connections`).
   * Absent or null: the default connection, and the only one there is with one connection.
   */
  connection?: string | null;
};

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
 * A Bot's saved default, where the person can run it. It names a kind of connection (`source`), not
 * one: a Bot is shared and each person runs it on their own. With several connections it applies on
 * the first one of that kind that can run and lists the model; otherwise, only when that kind is the
 * one in use. Undefined where it can't apply, so the run takes the default connection's default.
 */
export function offeredBotDefault(
  saved: AgentProfile["defaultModel"],
  catalogue: ModelCatalogue | undefined,
): ModelPick | undefined {
  if (!saved) return undefined;
  if (pickerGroups(catalogue).length > 0) {
    for (const connection of pickerGroups(catalogue)) {
      if (!connection.ready || connection.source !== saved.source) continue;
      const option = connection.models.find(({ id }) => id === saved.model);
      if (option)
        return {
          model: option.id,
          effort: accepts(option, saved.effort) ? saved.effort : null,
          connection: connection.id,
        };
    }
    return undefined;
  }
  if (saved.source !== catalogue?.source) return undefined;
  const option = optionFor(catalogue, saved.model);
  if (!option) return undefined;
  return {
    model: option.id,
    effort: accepts(option, saved.effort) ? saved.effort : null,
  };
}

/**
 * What a picker shows for a saved pick: the saved model when the catalogue still offers it,
 * otherwise the default, and the saved effort only where that model accepts it.
 *
 * With several connections, a pick that names one is shown on it while that connection still
 * lists the model. One whose connection left the catalogue (removed, or a person who just connected
 * their own on OpenBot Cloud) shows the default instead, as a model no longer offered does. A pick
 * that names none is the default connection's. With no default connection, nothing is shown until
 * someone picks.
 */
export function shownPick(
  saved: ConversationModel | null | undefined,
  catalogue: ModelCatalogue | undefined,
  botDefault?: ModelPick,
): ModelPick | undefined {
  if (!catalogue) return undefined;
  if (pickerGroups(catalogue).length === 0)
    return shownPickIn(saved, catalogue, botDefault);
  const named = saved?.connection
    ? connectionOf(catalogue, saved.connection)
    : undefined;
  // A stopped connection's pick is not moved anywhere: its run is refused and the person told so.
  if (named && !named.ready && saved?.model)
    return {
      model: saved.model,
      effort: saved.effort ?? null,
      connection: named.id,
    };
  if (named && optionFor(catalogueFor(catalogue, named), saved?.model)) {
    const pick = shownPickIn(saved, catalogueFor(catalogue, named));
    return pick && { ...pick, connection: named.id };
  }
  // The pick's connection or model is gone: what a run uses now, nothing pinned.
  const followed = saved?.connection ? null : saved;
  if (botDefault?.connection && !followed?.model) return botDefault;
  const fallback = connectionOf(catalogue, null);
  if (!fallback) return botDefault?.connection ? botDefault : undefined;
  const pick = shownPickIn(
    followed,
    catalogueFor(catalogue, fallback),
    botDefault && !botDefault.connection ? botDefault : undefined,
  );
  return pick && { ...pick, connection: fallback.id };
}

function shownPickIn(
  saved: ConversationModel | null | undefined,
  catalogue: ModelCatalogue,
  botDefault?: ModelPick,
): ModelPick | undefined {
  if (
    botDefault &&
    (saved?.model
      ? !optionFor(catalogue, saved.model)
      : !accepts(
          optionFor(catalogue, catalogue.default),
          saved?.effort ?? null,
        ))
  )
    return botDefault;
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
  botDefault?: ModelPick,
): ConversationModelInput {
  if (!catalogue || pickerGroups(catalogue).length === 0)
    return requestIn(pick, catalogue, botDefault);
  /*
   * Several connections. The default connection's own default is saved as null, so it follows the
   * default; any other model is saved with its connection, so changing the default never moves it.
   */
  const connection = connectionOf(catalogue, pick.connection ?? null);
  if (!connection) return requestIn(pick, catalogue, botDefault);
  const own = catalogueFor(catalogue, connection);
  const sameDefault =
    botDefault &&
    (botDefault.connection ?? connectionOf(catalogue, null)?.id) ===
      connection.id;
  if (connection.isDefault && (!botDefault || sameDefault)) {
    const request = requestIn(pick, own, botDefault);
    return request.model === null
      ? request
      : { ...request, connection: connection.id };
  }
  const option = optionFor(own, pick.model);
  const effort =
    accepts(option, pick.effort) && pick.effort !== option?.defaultEffort
      ? pick.effort
      : null;
  if (
    sameDefault &&
    botDefault?.model === pick.model &&
    shownEffort(option, effort) === shownEffort(option, botDefault.effort)
  )
    return { model: null, effort: null };
  return { model: pick.model, effort, connection: connection.id };
}

function requestIn(
  pick: ModelPick,
  catalogue: ModelCatalogue | undefined,
  botDefault?: ModelPick,
): ConversationModelInput {
  const option = optionFor(catalogue, pick.model);
  const effort =
    accepts(option, pick.effort) && pick.effort !== option?.defaultEffort
      ? pick.effort
      : null;
  if (botDefault) {
    const inheritedEffort = shownEffort(option, botDefault.effort);
    if (
      pick.model === botDefault.model &&
      shownEffort(option, effort) === inheritedEffort
    )
      return { model: null, effort: null };
    return {
      model: pick.model,
      effort,
      ...(pick.model === catalogue?.default ? { pinModel: true } : {}),
    };
  }
  return {
    model: pick.model === catalogue?.default ? null : pick.model,
    effort,
  };
}
