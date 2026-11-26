/** A link the phone may open in its browser. */
export function webLink(link: string | null) {
  if (!link) return null;
  try {
    const url = new URL(link);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}
