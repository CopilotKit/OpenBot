import type { Page } from "playwright-core";

/**
 * How a settings card's link to a screen is drawn, as a person sees it, for the browser tests that
 * draw the cards. Every settings card opens its screen with the same link: "Open Settings ›", in the
 * primary colour, a chevron after it, not underlined until hovered. The personal cards once had an
 * underlined "Open Settings" while the admin cards had "Open Routines ›" (found in the end-to-end run).
 */
export type ScreenLinkLook = {
  text: string;
  href: string;
  /** Underlined before anybody points at it. */
  underlined: boolean;
  /** A chevron drawn after the words. */
  chevron: boolean;
  /** In the app's primary colour. */
  primary: boolean;
  weight: string;
  size: string;
};

/** Every link to a screen in the cards `within` selects (every settings card by default), in order. */
export function screenLinkLooks(
  page: Page,
  within = "[data-settings-card]",
): Promise<ScreenLinkLook[]> {
  return page.evaluate((scope) => {
    // The primary colour as this stylesheet resolves it, read off an element drawn in it.
    const probe = document.createElement("span");
    probe.className = "text-primary";
    document.body.append(probe);
    const primary = getComputedStyle(probe).color;
    probe.remove();
    // A card's foot links: the ones whose words open a screen ("Open Settings").
    return [...document.querySelectorAll(scope)]
      .flatMap((card) => [...card.querySelectorAll("a")])
      .filter((link) => /^Open /.test(link.textContent?.trim() ?? ""))
      .map((link) => {
        const style = getComputedStyle(link);
        const svg = link.querySelector("svg");
        return {
          text: (link.textContent ?? "").replace(/\s+/g, " ").trim(),
          href: link.getAttribute("href") ?? "",
          underlined: style.textDecorationLine.includes("underline"),
          chevron: Boolean(
            svg?.classList.contains("tabler-icon-chevron-right") &&
              svg.getBoundingClientRect().left >=
                link.getBoundingClientRect().left +
                  link.getBoundingClientRect().width / 2,
          ),
          primary: style.color === primary,
          weight: style.fontWeight,
          size: style.fontSize,
        };
      });
  }, within);
}
