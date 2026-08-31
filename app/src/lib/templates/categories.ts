/**
 * The categories a template may put itself in, and the words this deployment draws for them.
 *
 * A CLOSED LIST, and that is the whole of the design. A category groups and filters the gallery, so
 * it decides where a stranger's file appears and what it appears beside. Free text there would let
 * whoever wrote the file invent a grouping, put a sentence in a chip, or name itself something that
 * sorts above everything else — three different ways for an author to steer what somebody sees
 * before they have read anything. The list is fixed here, the server refuses a value that is not on
 * it, and the file only ever supplies which of these nine it is.
 *
 * THE SLUG TRAVELS, THE LABEL DOES NOT. What is in the file and on the wire is `sales`; the words
 * "Customer Success & Support" are this app's, chosen here, and changing them changes no file and
 * invalidates no import. A label that travelled would be a second string an author controls.
 *
 * The order is the order the chips appear in. It is deliberately not count order: sorting by how
 * many templates are in each would let the row rearrange itself as somebody types, and would put
 * whichever category a pinned source happened to be full of at the front.
 */
export const TEMPLATE_CATEGORIES = [
  { slug: "general", label: "General" },
  { slug: "sales", label: "Sales" },
  { slug: "marketing", label: "Marketing" },
  { slug: "customer-success", label: "Customer Success & Support" },
  { slug: "recruiting", label: "Recruiting & People" },
  { slug: "operations-finance", label: "Operations & Finance" },
  { slug: "product", label: "Product" },
  { slug: "engineering", label: "Engineering" },
  { slug: "life", label: "Life & Leverage" },
] as const;

export type TemplateCategorySlug = (typeof TEMPLATE_CATEGORIES)[number]["slug"];

/**
 * A `Map` rather than an object literal, because the key is a string out of somebody else's file.
 * `"constructor" in {}` is true, and a lookup that answers yes for a prototype member would let a
 * template carrying `category: toString` draw a label made of JavaScript.
 */
const LABELS = new Map<string, string>(
  TEMPLATE_CATEGORIES.map((category) => [category.slug, category.label]),
);

export function isTemplateCategory(
  slug: string | null | undefined,
): slug is TemplateCategorySlug {
  return typeof slug === "string" && LABELS.has(slug);
}

/**
 * The words for a slug, or nothing.
 *
 * Nothing, rather than the slug itself, for a value this app does not recognise. The server refuses
 * an unknown category, so one reaching the browser means the two halves are different versions —
 * and the safe direction is the one `queries.ts` already takes for the whole format: a field the
 * screen cannot render is treated as absent rather than rendered by a guess. An unrecognised
 * category makes a template uncategorised, which is a true statement about what this app knows.
 */
export function templateCategoryLabel(
  slug: string | null | undefined,
): string | null {
  if (!isTemplateCategory(slug)) return null;
  return LABELS.get(slug) ?? null;
}
