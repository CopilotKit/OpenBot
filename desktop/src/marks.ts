/**
 * The vendored marks, inlined at build time as data URIs.
 *
 * Inlined rather than fetched because the setup window draws before anything guarantees a network,
 * and a picker whose tiles fill in late reads as broken. `eager` so the first paint has them.
 *
 * As URIs rather than SVG source on purpose: an `<img>` cannot execute anything, so drawing these
 * needs no `dangerouslySetInnerHTML` and the question of what is in the file never becomes a
 * security question at all.
 *
 * A row without an entry here is not an error: "an agent you already run" has no mark, nor would a
 * brand that publishes none, and such a row shows the name alone. See `shared/marks/README.md`.
 */
const files = import.meta.glob("../../shared/marks/*.svg", {
  eager: true,
  query: "?inline",
  import: "default",
}) as Record<string, string>;

const byId = new Map<string, string>(
  Object.entries(files).map(([path, uri]) => [
    path.replace(/^.*\/marks\//, "").replace(".svg", ""),
    uri,
  ]),
);

export function markFor(id: string | null | undefined): string | null {
  return (id && byId.get(id)) ?? null;
}
