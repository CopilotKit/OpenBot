import type { useFrontendTool } from "@copilotkit/react-core/v2";
import type { ReactElement } from "react";

/**
 * Discover gallery components from files that export `GALLERY`; deployment state owns publication,
 * grants, and published descriptions after first announcement.
 */

/** The schema type the SDK itself accepts, so a component never needs a cast to register. */
export type ToolParameters = Parameters<
  typeof useFrontendTool
>[0]["parameters"];

/** Grouping for the Admin page only. Never read by the model. */
export type GalleryKind = "chart" | "card" | "decision";

export type GalleryComponent = {
  /**
   * The tool name the model calls, the catalogue key, and the stable fork-facing component id.
   */
  name: string;
  /** What a person sees in Admin and in a refusal. */
  title: string;
  kind: GalleryKind;
  /**
   * What the model reads while deciding whether to call this. A starting value only: a deployment
   * edits and publishes its own, and that is what a running Bot is given.
   */
  description: string;
  parameters: ToolParameters;
  /**
   * The props that show this component at its best, for anywhere it is displayed rather than called.
   *
   * A gallery of names tells somebody nothing: the question they arrived with is "what does an
   * answer from this thing look like", and only the component itself answers that. Kept beside the
   * component so a new one cannot be added without deciding how it introduces itself.
   *
   * Props rather than tool arguments, because they are not always the same thing: a component that
   * suspends the run is handed the whole interaction, `{ status, args, respond }`, and would crash
   * on arguments alone.
   *
   * Omitted by a component that cannot be drawn away from a conversation, which is then shown as an
   * unpreviewable tile rather than as a component that failed.
   */
  preview?: Record<string, unknown>;
  Component: (props: Record<string, unknown>) => ReactElement | null;
  /**
   * The line the model is given once it is on screen. Ignored for a `decision`, whose result is the
   * user's answer.
   */
  confirmation?: string;
  /**
   * The data functions this component will read, given the arguments it was called with.
   *
   * A component that reads nothing omits it. One that does declares it here so the grant covering
   * that data is decided before the model is told the component is on screen.
   */
  reads?: (args: Record<string, unknown>) => readonly string[];
};

/**
 * Every gallery module, loaded eagerly because the list has to exist before the first render: it
 * decides how many hooks are registered, and a hook count that arrives late is a hook count that
 * changed.
 *
 * Uses a relative pattern because `import.meta.glob` does not resolve the `@/` alias. Files without
 * a `GALLERY` export are skipped.
 */
let modules: Record<string, { GALLERY?: GalleryComponent[] }> = {};
try {
  // Keep this call inline: Vite replaces `import.meta.glob` at build time.
  modules = import.meta.glob<{ GALLERY?: GalleryComponent[] }>(
    "../../components/gallery/*.tsx",
    { eager: true },
  );
} catch {
  // Outside Vite/test-runner contexts, `import.meta.glob` may be unavailable; empty gallery is the safe fallback.
  modules = {};
}

/**
 * Stable order is required because this list drives hook registration order.
 */
export const GALLERY_COMPONENTS: GalleryComponent[] = Object.values(modules)
  .flatMap((module) => module.GALLERY ?? [])
  .sort((left, right) => left.name.localeCompare(right.name));

/** What the server is told exists. Deliberately not the schema or the renderer: it cannot use either. */
export type GalleryManifestEntry = {
  name: string;
  title: string;
  kind: GalleryKind;
  description: string;
};

export function galleryManifest(): GalleryManifestEntry[] {
  return GALLERY_COMPONENTS.map(({ name, title, kind, description }) => ({
    name,
    title,
    kind,
    description,
  }));
}

/** The names this build can actually draw, for telling a catalogue row from a component. */
export const RENDERABLE_NAMES: ReadonlySet<string> = new Set(
  GALLERY_COMPONENTS.map((component) => component.name),
);

const BY_NAME: ReadonlyMap<string, GalleryComponent> = new Map(
  GALLERY_COMPONENTS.map((component) => [component.name, component]),
);

/**
 * The component behind a catalogue name, or `undefined` where this build has no renderer for it.
 *
 * A deployment's component rows are governance state and outlive the build that drew them, so a
 * name arriving from the server is not a promise that anything here can draw it.
 */
export function galleryComponent(name: string): GalleryComponent | undefined {
  return BY_NAME.get(name);
}
