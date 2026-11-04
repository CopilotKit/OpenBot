import { isDeepStrictEqual } from "node:util";
import { type AuditStore, recordAuditEvent } from "../audit";
import {
  ConfigurationConflictError,
  configurationKey,
} from "../configuration/client";
import { botConfiguration } from "../configuration/directory";
import type { ComponentEntry, ComponentSource } from "../configuration/types";
import type { Database } from "../db/client";
import {
  byText,
  changeComponent,
  componentState,
  findComponent,
} from "./catalogue-records";

/**
 * Components authored in a browser rather than compiled into the build.
 *
 * This exists alongside the React path rather than instead of it. A registered React component is
 * what a customer's own front-end engineers write: it inherits their design system, their component
 * library and their review process, and it is the right primary path. It also costs a deployment.
 * That is fine for engineers and wrong for lightweight edits: a solutions engineer wanting one
 * temporary card, an analyst changing a column heading, and anything a model
 * produces, which cannot be a file in the repository by definition.
 *
 * The governance is the same governance. Saving one writes a row in `components` too, so the grant
 * grid, the published description and the per-Bot decision all work on it unchanged. An operator
 * deciding what a Bot may answer with should never have to know which of the two kinds they are
 * looking at, and two grant surfaces would be two things to keep in step.
 *
 * The source has its own publish gate. Publishing without a rebuild is
 * the entire point of this table and it is also what puts an editor one keystroke from changing what
 * every Bot draws in production. A draft absorbs that: edited freely, previewed against sample
 * arguments, and reaching nobody until somebody publishes it.
 */

export type SandboxedRecord = {
  name: string;
  title: string;
  draftDescription: string;
  draftHtml: string;
  draftCss: string;
  draftJsFunctions: string;
  draftArgumentSchema: Record<string, unknown>;
  publishedHtml: string | null;
  publishedCss: string | null;
  publishedJsFunctions: string | null;
  publishedArgumentSchema: Record<string, unknown> | null;
  sampleArguments: Record<string, unknown>;
  revision: number;
  published: boolean;
  publishedAt: string | null;
  authoredBy: string | null;
  hasUnpublishedChanges: boolean;
};

/** What a Bot may actually draw with: the published source, or nothing at all. */
export type PublishedSandboxed = {
  name: string;
  html: string;
  css: string;
  jsFunctions: string;
  /**
   * The arguments this component takes, as the author described them.
   *
   * Without this the tool advertises no parameters, and a model told a tool takes nothing calls it
   * with nothing.
   */
  argumentSchema: Record<string, unknown>;
};

export class SandboxedNotFoundError extends Error {
  constructor(name: string) {
    super(`No component is called ${name}.`);
    this.name = "SandboxedNotFoundError";
  }
}

export class SandboxedNameRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxedNameRefusedError";
  }
}

/** A playground component cannot be published as a drawable thing until its source is usable. */
export class SandboxedPublicationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxedPublicationRefusedError";
  }
}

const iso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

function sameJson(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

/**
 * The one place a sandboxed component's name is decided.
 *
 * Namespaced so it can never collide with a compiled one. Both kinds share the `components` table
 * and both are tool names the model calls, so a playground save that happened to pick `showBarChart`
 * would quietly take over the renderer for a component the build ships. The prefix makes that
 * impossible rather than unlikely, and it also tells a reader of the audit trail which kind drew
 * something without having to look it up.
 */
export const SANDBOXED_PREFIX = "custom_";

export function sandboxedNameFor(slug: string): string {
  return `${SANDBOXED_PREFIX}${slug}`;
}

export function createSandboxedStore(
  _database: Database,
  auditStore: AuditStore,
) {
  /** The component, if it has playground source. */
  async function requireRow(name: string) {
    const entry = await findComponent(name);
    if (!entry?.source) throw new SandboxedNotFoundError(name);
    return entry;
  }

  const toRecord = (entry: ComponentEntry): SandboxedRecord => {
    const source = entry.source as ComponentSource;
    const draft = source.draft;
    const published = source.published;
    return {
      name: entry.name,
      title: entry.title,
      draftDescription: draft.description,
      draftHtml: draft.html,
      draftCss: draft.css,
      draftJsFunctions: draft.jsFunctions,
      draftArgumentSchema: draft.argumentSchema,
      publishedHtml: published?.html ?? null,
      publishedCss: published?.css ?? null,
      publishedJsFunctions: published?.jsFunctions ?? null,
      publishedArgumentSchema: published?.argumentSchema ?? null,
      sampleArguments: source.sampleArguments,
      revision: source.revision,
      published: source.isPublished,
      publishedAt: iso(source.publishedAt),
      authoredBy: source.authoredBy,
      hasUnpublishedChanges:
        source.isPublished &&
        (draft.html !== (published?.html ?? null) ||
          draft.css !== (published?.css ?? null) ||
          draft.jsFunctions !== (published?.jsFunctions ?? null)),
    };
  };

  return {
    async list(): Promise<SandboxedRecord[]> {
      return botConfiguration()
        .components.all()
        .filter((entry) => entry.source !== null)
        .sort((left, right) => byText(left.title, right.title))
        .map(toRecord);
    },

    /**
     * Save a draft.
     *
     * The component's governance is written in the same record, unpublished, so the new component
     * appears in the grid straight away and no Bot can draw it yet. Publishing is the decision that
     * hands it to every Bot, so it happens after somebody has looked at it rather than the moment it
     * is saved.
     */
    async save(input: {
      slug: string;
      title: string;
      description: string;
      html: string;
      css: string;
      jsFunctions: string;
      argumentSchema: Record<string, unknown>;
      sampleArguments: Record<string, unknown>;
      by: string;
    }): Promise<SandboxedRecord> {
      if (!/^[a-z0-9][a-z0-9_]{0,38}[a-z0-9]$/.test(input.slug)) {
        throw new SandboxedNameRefusedError(
          "A name is lower-case letters, numbers and underscores.",
        );
      }
      const name = sandboxedNameFor(input.slug);
      const draft = {
        description: input.description,
        html: input.html,
        css: input.css,
        jsFunctions: input.jsFunctions,
        argumentSchema: input.argumentSchema,
      };
      const configuration = botConfiguration();

      for (let attempt = 1; ; attempt++) {
        // `published` is left alone on an existing one: an administrator publishing it is their
        // decision, and a save must not quietly undo or advance it.
        const saved = await changeComponent(name, (entry) => ({
          ...componentState(entry),
          title: input.title,
          draftDescription: input.description,
          updatedBy: input.by,
          source: {
            draft,
            published: entry.source?.published ?? null,
            sampleArguments: input.sampleArguments,
            revision: entry.source?.revision ?? 0,
            isPublished: entry.source?.isPublished ?? false,
            publishedAt: entry.source?.publishedAt ?? null,
            authoredBy: input.by,
            createdAt: entry.source?.createdAt ?? new Date(),
            updatedAt: new Date(),
          },
        }));
        if (saved) break;
        try {
          configuration.components.apply(
            await configuration.client.components.create(
              name,
              {
                title: input.title,
                kind: "sandboxed",
                draftDescription: input.description,
                publishedDescription: null,
                published: false,
                publishedAt: null,
                updatedBy: input.by,
                functions: [],
                withheldFrom: [],
                source: {
                  draft,
                  published: null,
                  sampleArguments: input.sampleArguments,
                  revision: 0,
                  isPublished: false,
                  publishedAt: null,
                  authoredBy: input.by,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                },
              },
              configurationKey("sandboxed-save"),
            ),
          );
          break;
        } catch (error) {
          // Another save made it first: this one becomes an edit of it.
          if (!(error instanceof ConfigurationConflictError) || attempt >= 3)
            throw error;
          await configuration.components.refresh(name);
        }
      }

      await recordAuditEvent(auditStore, {
        eventType: "component.draft_saved",
        targetType: "component",
        targetId: name,
        payload: { actor: input.by, kind: "sandboxed" },
      });

      return toRecord(await requireRow(name));
    },

    /**
     * Publish: the source and the description, in one act.
     *
     * One button because it is one decision. Publishing the wording without the markup would offer
     * the model a component that draws the previous version, and publishing the markup without the
     * wording would leave a component no model is told about. Both halves are one record in
     * Intelligence, written together or not at all.
     */
    async publish(name: string, by: string): Promise<SandboxedRecord> {
      let changed = false;
      const refusal = (entry: ComponentEntry) => {
        if (!entry.source) {
          return new SandboxedPublicationRefusedError(
            `${name} has no stored playground source to publish.`,
          );
        }
        if (entry.kind !== "sandboxed") {
          return new SandboxedPublicationRefusedError(
            `${name} has no playground governance row to publish.`,
          );
        }
        if (!entry.source.draft.description.trim()) {
          return new SandboxedPublicationRefusedError(
            `${name} needs a description before it can be published.`,
          );
        }
        if (!entry.source.draft.html.trim()) {
          return new SandboxedPublicationRefusedError(
            `${name} needs rendered HTML before it can be published.`,
          );
        }
        return null;
      };
      const written = await changeComponent(name, (entry) => {
        changed = false;
        const refused = refusal(entry);
        if (refused) throw refused;
        const source = entry.source as ComponentSource;
        const published = source.published;
        const draft = source.draft;
        const unchanged =
          source.isPublished &&
          entry.published &&
          published !== null &&
          published.description === draft.description &&
          published.html === draft.html &&
          published.css === draft.css &&
          published.jsFunctions === draft.jsFunctions &&
          sameJson(published.argumentSchema, draft.argumentSchema);
        if (unchanged) return null;
        changed = true;
        const now = new Date();
        return {
          ...componentState(entry),
          publishedDescription: draft.description,
          published: true,
          publishedAt: now,
          updatedBy: by,
          source: {
            ...source,
            published: { ...draft },
            isPublished: true,
            publishedAt: now,
            revision: source.revision + 1,
            updatedAt: now,
          },
        };
      });
      if (!written) {
        throw new SandboxedPublicationRefusedError(
          `${name} has no stored playground source to publish.`,
        );
      }
      const record = toRecord(written);

      if (changed) {
        await recordAuditEvent(auditStore, {
          eventType: "component.published",
          targetType: "component",
          targetId: name,
          payload: {
            actor: by,
            kind: "sandboxed",
            revision: record.revision,
          },
        });
      }
      return record;
    },

    /**
     * Withdraw a playground component from every Bot.
     *
     * The source and the governance are two halves of one publication, so they are withdrawn
     * together. The published source stays put: re-publishing the same draft is a decision to make
     * it drawable again, not a request to reconstruct source that was deliberately retained.
     */
    async unpublish(name: string, by: string): Promise<void> {
      let changed = false;
      const written = await changeComponent(name, (entry) => {
        changed = false;
        if (entry.kind !== "sandboxed") throw new SandboxedNotFoundError(name);
        if (!entry.published && !entry.source?.isPublished) return null;
        changed = true;
        return {
          ...componentState(entry),
          published: false,
          updatedBy: by,
          source: entry.source
            ? { ...entry.source, isPublished: false, updatedAt: new Date() }
            : null,
        };
      });
      if (!written) throw new SandboxedNotFoundError(name);

      if (!changed) return;
      await recordAuditEvent(auditStore, {
        eventType: "component.unpublished",
        targetType: "component",
        targetId: name,
        payload: { actor: by, kind: "sandboxed" },
      });
    },

    async remove(name: string, by: string): Promise<void> {
      /*
       * Refuse a name this surface does not own.
       *
       * The catalogue is shared with the compiled components and the delete below is by name. A
       * compiled component's record removed through the playground's endpoint would take its per-Bot
       * withholdings and its function grants with it, and the withholdings are the half that fails
       * open: a published component is available to every Bot unless a withholding says otherwise,
       * and the next catalogue announcement registers the component again as published. A deliberate
       * "not this Bot" would come back as "every Bot", under an audit row saying `kind:
       * "sandboxed"`, which is the one thing it was not.
       *
       * Asked of the governance `kind` rather than of whether there is source, because ownership is
       * the actual question: a playground component whose source went missing is still this
       * surface's to clean up.
       */
      const entry = await findComponent(name);
      // "sandboxed" is the kind `save` writes above. A name with nothing at all is refused for the
      // same reason `publish` refuses one: this surface has nothing by that name to act on.
      if (entry?.kind !== "sandboxed") {
        throw new SandboxedNotFoundError(name);
      }

      // The governance, the source, the withholdings and the function grants, in one delete.
      const configuration = botConfiguration();
      await configuration.client.components.remove(
        name,
        configurationKey("sandboxed-remove"),
      );
      configuration.components.forget(name);

      await recordAuditEvent(auditStore, {
        eventType: "component.unpublished",
        targetType: "component",
        targetId: name,
        payload: { actor: by, kind: "sandboxed", change: "deleted" },
      });
    },

    /**
     * The published source for every sandboxed component, which is what the app renders from.
     *
     * Published only, and null is not a fallback. A component that has never been published has no
     * published source, so it is absent from this list and the app has nothing to draw. A draft
     * quietly rendering in production is the one outcome the draft exists to prevent.
     */
    async published(): Promise<PublishedSandboxed[]> {
      return botConfiguration()
        .components.all()
        .flatMap((entry) => {
          const source = entry.source;
          if (!source?.isPublished || !source.published) return [];
          return [
            {
              name: entry.name,
              html: source.published.html,
              css: source.published.css,
              jsFunctions: source.published.jsFunctions,
              argumentSchema: source.published.argumentSchema,
            },
          ];
        });
    },
  };
}

export type SandboxedStore = ReturnType<typeof createSandboxedStore>;
