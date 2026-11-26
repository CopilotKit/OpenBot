/*
 * The workbench page takes the app's theme (app/src/theme.css), which reads `.dark` on <html>.
 * The app's own index.html sets it from the computer's light or dark setting before the first
 * paint. The workbench has no Theme setting of its own, so it follows the computer only, and
 * keeps following it while the page is open.
 */

type DarkMedia = Pick<
  MediaQueryList,
  "matches" | "addEventListener" | "removeEventListener"
>;

/** Puts `.dark` and `color-scheme` on <html> from the media, and follows its changes. */
export function followPageTheme(
  doc: Document = document,
  media: DarkMedia = window.matchMedia("(prefers-color-scheme: dark)"),
): () => void {
  const apply = (dark: boolean) => {
    doc.documentElement.classList.toggle("dark", dark);
    doc.documentElement.style.colorScheme = dark ? "dark" : "light";
  };
  const onChange = (event: { matches: boolean }) => apply(event.matches);
  apply(media.matches);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
