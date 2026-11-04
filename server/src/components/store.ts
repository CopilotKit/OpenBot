import { configurationKey } from "../configuration/client";
import { botConfiguration } from "../configuration/directory";
import type { ComponentEntry, ComponentState } from "../configuration/types";
import type { Database } from "../db/client";
import {
  byText,
  changeComponent,
  componentState,
  findComponent,
} from "./catalogue-records";
import { dataFunction } from "./functions";

export type ComponentRecord = {
  name: string;
  title: string;
  kind: string;
  draftDescription: string;
  publishedDescription: string | null;
  published: boolean;
  publishedAt: string | null;
  updatedBy: string | null;
  updatedAt: string;
  /** Whether the draft says something the published version does not. */
  hasUnpublishedChanges: boolean;
  /** The Bots held back from this. Every other Bot, including ones added later, may use it. */
  withheldFrom: string[];
  /** The data functions this component may call. Empty means it may call none. */
  functions: string[];
};

/** What one Bot may answer with, which is all the app needs to register its tools. */
export type GrantedComponent = {
  name: string;
  /** The published description. A draft is never sent anywhere a model can read it. */
  description: string;
};

/**
 * The outcome of asking whether a Bot may use a component right now.
 *
 * `reason` is written to be read by the model and shown to the person, so it says what happened and
 * what it means rather than naming a table.
 */
export type ComponentDecision =
  | { allowed: true; description: string }
  | { allowed: false; reason: string };

export class ComponentNotFoundError extends Error {
  constructor(name: string) {
    super(`No component is called ${name}.`);
    this.name = "ComponentNotFoundError";
  }
}

/**
 * The generic publication path found a playground component.
 *
 * Its source is not in this table and a generic write would publish the governance half alone. The
 * route catches this and delegates to the sandboxed store, which owns the two-row transaction.
 */
export class SandboxedPublicationRequiredError extends Error {
  constructor(name: string) {
    super(
      `${name} is a playground component and must be published from its source.`,
    );
    this.name = "SandboxedPublicationRequiredError";
  }
}

/** What a build says it can draw. The app announces this; the server keeps no copy of its own. */
export type CatalogueEntry = {
  name: string;
  title: string;
  kind: string;
  description: string;
};

export type ComponentStore = {
  /**
   * Learn about components this deployment has not seen before.
   *
   * Additive, never overwriting. A row that already exists belongs to the deployment: its published
   * wording, its grants and whether it is published at all were decided here, and an upgrade that
   * quietly reset any of them would be this function undoing an administrator\'s work on every boot.
   * Safe to call on every page load for that reason.
   */
  syncCatalogue(entries: CatalogueEntry[]): Promise<{ added: string[] }>;
  list(): Promise<ComponentRecord[]>;
  /** What this Bot may answer with: everything published, less whatever it has been held back from. */
  listForAgent(agentId: string): Promise<GrantedComponent[]>;
  /**
   * The one decision point. Everything that wants to know whether a Bot may use a component asks
   * here, so there is a single place where the answer is decided and a single place to audit it.
   */
  decide(name: string, agentId: string): Promise<ComponentDecision>;
  /** Stop holding this Bot back from this component. Takes no actor: it writes no row. */
  grant(name: string, agentId: string): Promise<void>;
  /** Hold this Bot back from this one component. Every other Bot is unaffected. */
  revoke(name: string, agentId: string, by: string): Promise<void>;
  grantFunction(name: string, functionName: string, by: string): Promise<void>;
  revokeFunction(name: string, functionName: string): Promise<void>;
  /**
   * May this component call this function?
   *
   * Separate from {@link ComponentStore.decide} rather than folded into it, because they answer
   * different questions and a caller needs both: whether this Bot may use the component at all, and
   * whether the component may read this data. Answering them together would let a caller satisfy one
   * and believe it had satisfied the other.
   */
  mayCall(name: string, functionName: string): Promise<boolean>;
  /** Run a data function against this deployment. Permission is the caller's question, not this one's. */
  callFunction(
    functionName: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  publish(name: string, by: string): Promise<void>;
  unpublish(name: string, by: string): Promise<void>;
  saveDraft(name: string, description: string, by: string): Promise<void>;
};

const iso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

/**
 * The catalogue's governance, read from what this instance holds of Intelligence's UI components and
 * written there (see `catalogue-records.ts`). Every run's component list and every component call is
 * answered from memory.
 */
export function createComponentStore(database: Database): ComponentStore {
  async function requireComponent(name: string) {
    const entry = await findComponent(name);
    if (!entry) throw new ComponentNotFoundError(name);
    return entry;
  }

  /** Change one component, refusing a name nobody has. */
  async function change(
    name: string,
    work: (entry: ComponentEntry) => ComponentState | null,
  ) {
    const changed = await changeComponent(name, work);
    if (!changed) throw new ComponentNotFoundError(name);
    return changed;
  }

  return {
    async syncCatalogue(entries) {
      if (entries.length === 0) return { added: [] };

      const catalogue = botConfiguration().components;
      const missing = entries.filter((entry) => !catalogue.get(entry.name));
      if (missing.length === 0) return { added: [] };

      /*
       * Registered in Intelligence, which creates only the names it does not have and leaves every
       * other exactly as the deployment decided it: published on arrival, so a fresh install can draw
       * from the moment it starts.
       *
       * Two browsers announcing the same new component at once is ordinary, not a fault: Intelligence
       * reports a name to the one call that created it, so the trail, which writes a row per name the
       * caller is told about, records each arrival once.
       */
      const added = await botConfiguration().client.components.register(
        "the build",
        missing,
        configurationKey("component-register"),
      );
      for (const name of missing.map((entry) => entry.name))
        await catalogue.refresh(name);
      return { added };
    },

    async list() {
      return botConfiguration()
        .components.all()
        .sort(
          (left, right) =>
            byText(left.kind, right.kind) || byText(left.title, right.title),
        )
        .map((row) => ({
          name: row.name,
          title: row.title,
          kind: row.kind,
          draftDescription: row.draftDescription,
          publishedDescription: row.publishedDescription,
          published: row.published,
          publishedAt: iso(row.publishedAt),
          updatedBy: row.updatedBy,
          updatedAt: row.updatedAt.toISOString(),
          hasUnpublishedChanges:
            row.draftDescription !== (row.publishedDescription ?? ""),
          withheldFrom: row.withheldFrom.map((entry) => entry.botId).sort(),
          functions: row.functions.map((fn) => fn.name).sort(),
        }));
    },

    async listForAgent(agentId) {
      // A published row with no description is not a thing the model can be told about, so it is
      // left out rather than sent as an empty string it would have to guess the meaning of. Held back
      // from this Bot specifically, so another Bot's withholding cannot remove one here.
      return botConfiguration()
        .components.all()
        .filter(
          (row) =>
            row.published &&
            Boolean(row.publishedDescription) &&
            !row.withheldFrom.some((entry) => entry.botId === agentId),
        )
        .sort((left, right) => byText(left.name, right.name))
        .map((row) => ({
          name: row.name,
          description: row.publishedDescription ?? "",
        }));
    },

    async decide(name, agentId) {
      const row = botConfiguration().components.get(name);

      // Every refusal says which one it is. "Not allowed" sends a model round the same loop; naming
      // the cause lets it either pick a different component or tell the person what to change.
      if (!row) {
        return {
          allowed: false,
          reason: `There is no component called ${name} in this deployment. Answer in prose instead.`,
        };
      }
      if (!row.published || !row.publishedDescription) {
        return {
          allowed: false,
          reason: `${row.title} is not published in this deployment, so no Bot may use it. Answer in prose instead.`,
        };
      }
      if (row.withheldFrom.some((entry) => entry.botId === agentId)) {
        return {
          allowed: false,
          reason: `${row.title} has been withheld from this Bot in this deployment, though other Bots may use it. Answer in prose instead.`,
        };
      }
      return { allowed: true, description: row.publishedDescription };
    },

    async grant(name, agentId) {
      await change(name, (entry) =>
        entry.withheldFrom.some((withheld) => withheld.botId === agentId)
          ? {
              ...componentState(entry),
              withheldFrom: componentState(entry).withheldFrom.filter(
                (withheld) => withheld.botId !== agentId,
              ),
            }
          : null,
      );
    },

    async revoke(name, agentId, by) {
      await change(name, (entry) =>
        // Withholding twice must not move the date.
        entry.withheldFrom.some((withheld) => withheld.botId === agentId)
          ? null
          : {
              ...componentState(entry),
              withheldFrom: [
                ...componentState(entry).withheldFrom,
                { botId: agentId, withheldBy: by },
              ],
            },
      );
    },

    async publish(name, by) {
      const row = await requireComponent(name);
      if (row.kind === "sandboxed") {
        throw new SandboxedPublicationRequiredError(name);
      }
      await change(name, (entry) => {
        if (entry.kind === "sandboxed")
          throw new SandboxedPublicationRequiredError(name);
        return {
          ...componentState(entry),
          // Promotes the draft, which is the whole of what publishing means here.
          publishedDescription: entry.draftDescription,
          published: true,
          publishedAt: new Date(),
          updatedBy: by,
        };
      });
    },

    async unpublish(name, by) {
      const row = await requireComponent(name);
      if (row.kind === "sandboxed") {
        throw new SandboxedPublicationRequiredError(name);
      }
      await change(name, (entry) => {
        if (entry.kind === "sandboxed")
          throw new SandboxedPublicationRequiredError(name);
        // Grants are left alone. Unpublishing is "nobody may use this for now", not "forget who was
        // trusted with it", clearing them would silently destroy an administrator's work and make
        // re-publishing a re-grant of everything.
        return { ...componentState(entry), published: false, updatedBy: by };
      });
    },

    async grantFunction(name, functionName, by) {
      await change(name, (entry) =>
        entry.functions.some((fn) => fn.name === functionName)
          ? null
          : {
              ...componentState(entry),
              functions: [
                ...componentState(entry).functions,
                { name: functionName, grantedBy: by },
              ],
            },
      );
    },

    async revokeFunction(name, functionName) {
      /*
       * Refused for a name nobody has, as the other three grant writes are. A revoke against a name
       * nobody has used to delete nothing, and the route then answered `revoked: true` and wrote
       * `component.function_revoked` for a component that was never there.
       */
      await change(name, (entry) =>
        entry.functions.some((fn) => fn.name === functionName)
          ? {
              ...componentState(entry),
              functions: componentState(entry).functions.filter(
                (fn) => fn.name !== functionName,
              ),
            }
          : null,
      );
    },

    async mayCall(name, functionName) {
      // A grant is the permission. None, no call, including for a component nobody has granted
      // anything, which is every component the moment it is added.
      return Boolean(
        botConfiguration()
          .components.get(name)
          ?.functions.some((fn) => fn.name === functionName),
      );
    },

    async callFunction(functionName, args) {
      const fn = dataFunction(functionName);
      // Unreachable through the route, which resolves the function before asking about permission.
      // Kept because a store that runs whatever name it is handed is one refactor away from being the
      // hole this whole file exists to close.
      if (!fn) throw new ComponentNotFoundError(functionName);
      return fn.run(database, args);
    },

    async saveDraft(name, description, by) {
      await change(name, (entry) => ({
        ...componentState(entry),
        draftDescription: description,
        updatedBy: by,
      }));
    },
  };
}
