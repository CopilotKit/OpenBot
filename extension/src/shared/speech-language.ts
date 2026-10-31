/** A language tag the speech recognizer can take: a well-formed BCP 47 tag of a language with an optional script and
 * region ("en", "en-GB", "zh-Hant-TW"), in its canonical form. Anything else (an empty `lang`, "x-klingon", a tag with
 * private-use parts or extensions) is null, so the caller falls back to the browser's language. */
export function speechLanguage(candidate: unknown): string | null {
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim().replaceAll("_", "-");
  if (
    !/^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|\d{3}))?$/.test(trimmed)
  )
    return null;
  try {
    return Intl.getCanonicalLocales(trimmed)[0] ?? null;
  } catch {
    return null;
  }
}

/** The narration's language: the page's own when it declares a usable one, else the browser's, else English. */
export function narrationLanguage(
  pageLanguage: unknown,
  browserLanguage: unknown,
): string {
  return (
    speechLanguage(pageLanguage) ?? speechLanguage(browserLanguage) ?? "en-US"
  );
}
