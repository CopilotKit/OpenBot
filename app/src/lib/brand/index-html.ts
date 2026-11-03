import type { AppConfig } from "../generated/application-config";

/*
 * The tenant's brand in the page shell, written into `index.html` at build time by the Vite config.
 *
 * The tab title and the tenant theme have to be in the HTML itself: the title is what a tab and a
 * bookmark show before any script runs, and a theme applied from script would paint the default
 * colours first and then flash to the tenant's.
 */

const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * The tenant theme with selectors that win over the app's own `theme.css`.
 *
 * Both define `:root` and `.dark`, so at equal specificity the winner would be whichever the page
 * happened to load last, and Vite decides where the built stylesheet goes. `html:root` and
 * `html.dark` are one step more specific, so the tenant's values win wherever they land.
 *
 * The theme was validated when the package loaded: only `:root` and `.dark` blocks of approved
 * variables, no imports and no URLs. `</` cannot appear in a valid theme, but it is refused here as
 * well, since it is the one sequence that could close the `<style>` element early.
 */
export function tenantThemeStyle(themeCss: string): string {
  if (!themeCss.trim()) return "";
  if (themeCss.includes("</")) {
    throw new Error("Tenant theme must not contain '</'");
  }
  const css = themeCss
    .replace(/(^|[\s}])\.dark(\s*\{)/g, "$1html.dark$2")
    .replace(/(^|[\s}]):root(\s*\{)/g, "$1html:root$2");
  return `<style id="tenant-theme">\n${css}\n</style>`;
}

export function brandIndexHtml(
  html: string,
  brand: AppConfig["brand"],
): string {
  const name = escapeHtml(brand.productName);
  // A `data:` URI from the package, so the icon is never a file served from this origin.
  const icon = brand.faviconUrl?.startsWith("data:image/")
    ? `\n    <link rel="icon" href="${escapeHtml(brand.faviconUrl)}" />`
    : "";
  const withTitle = html.replace(
    /<title>[^<]*<\/title>/,
    `<title>${name}</title>\n    <meta name="application-name" content="${name}" />${icon}`,
  );
  const style = tenantThemeStyle(brand.themeCss);
  return style
    ? withTitle.replace("</head>", `    ${style}\n  </head>`)
    : withTitle;
}
