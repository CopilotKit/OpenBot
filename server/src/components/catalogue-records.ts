/**
 * The component catalogue as Intelligence holds it (its UI components), and the one way this server
 * changes an entry in it.
 *
 * Each component is one record in Intelligence: its governance (published, the description a model
 * reads), the functions it may call, the Bots held back from it, and a playground component's source.
 * Every instance holds the whole catalogue in memory (configuration/directory.ts), because a run's
 * component list and every component call read it.
 *
 * ONE WAY TO CHANGE ONE. A change reads the entry this instance holds, works out the whole entry as it
 * should be, and writes it at the version it read. When somebody else wrote first, Intelligence
 * refuses the stale version, the entry is read again and the change is worked out again on top of
 * theirs. So two administrators withholding two Bots at once both stand, as they did when each was a
 * row of its own, and a publish that promotes a draft promotes the draft as it is now.
 */
import {
  ConfigurationConflictError,
  ConfigurationMissingError,
  configurationKey,
} from "../configuration/client";
import { botConfiguration } from "../configuration/directory";
import type { ComponentEntry, ComponentState } from "../configuration/types";

/** How many times a change is worked out again on top of somebody else's. */
const CHANGE_ATTEMPTS = 4;

/** The writable state of an entry, as it is. */
export function componentState(entry: ComponentEntry): ComponentState {
  return {
    title: entry.title,
    kind: entry.kind,
    draftDescription: entry.draftDescription,
    publishedDescription: entry.publishedDescription,
    published: entry.published,
    publishedAt: entry.publishedAt,
    updatedBy: entry.updatedBy,
    functions: entry.functions.map((fn) => ({ ...fn })),
    withheldFrom: entry.withheldFrom.map((withheld) => ({ ...withheld })),
    source: entry.source,
  };
}

/** The entry this instance holds, or Intelligence's when this instance has not heard of it yet. */
export async function findComponent(
  name: string,
): Promise<ComponentEntry | null> {
  const catalogue = botConfiguration().components;
  return catalogue.get(name) ?? (await catalogue.refresh(name));
}

/**
 * Change one entry. `change` sees the entry as it is now and returns the whole entry as it should be,
 * or null for nothing to write. Returns the entry as written, or as it was when nothing changed, or
 * null when there is no such component (then `change` was never called).
 */
export async function changeComponent(
  name: string,
  change: (entry: ComponentEntry) => ComponentState | null,
): Promise<ComponentEntry | null> {
  const configuration = botConfiguration();
  let entry = await findComponent(name);
  for (let attempt = 1; ; attempt++) {
    if (!entry) return null;
    const next = change(entry);
    if (next === null) return entry;
    try {
      const saved = await configuration.client.components.replace(
        name,
        entry.version,
        next,
        configurationKey("component-change"),
      );
      return configuration.components.apply(saved);
    } catch (error) {
      if (error instanceof ConfigurationMissingError) {
        configuration.components.forget(name);
        return null;
      }
      if (
        !(error instanceof ConfigurationConflictError) ||
        attempt >= CHANGE_ATTEMPTS
      )
        throw error;
      entry = await configuration.components.refresh(name);
    }
  }
}

/** Sorted as this deployment's database sorted text: by its collation, not by code point. */
export function byText(left: string, right: string): number {
  return left.localeCompare(right);
}
