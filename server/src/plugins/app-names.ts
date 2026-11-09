/**
 * An app's name as a person reads it, from the name the broker's catalogue publishes.
 *
 * The catalogue usually carries the brand's own spelling ("PostHog", "HubSpot"), but a handful of
 * names arrive all lowercase. On 2026-11-08 there were 12 of 1,723, and "1password" was the one a
 * person meets first. The directory showed "Needs a key from 1password", and enabling an app
 * stores its title from this same name, so the tile and the app page would say it too.
 *
 * The map holds brands whose spelling is checked against the brand's own site. Past that, an
 * all-lowercase word gets a capital first letter ("mailfloss" reads "Mailfloss"). A name with a
 * dot is left alone, because those are domain-style brands written lowercase on purpose
 * ("incident.io", "urlscan.io"). A name starting with a digit has no first letter to capitalise,
 * which is why 1Password is in the map.
 */
const DISPLAY_NAMES: Record<string, string> = {
  _1password: "1Password",
};

export function displayName(slug: string, published: string): string {
  if (Object.hasOwn(DISPLAY_NAMES, slug)) return DISPLAY_NAMES[slug] as string;
  if (published !== published.toLowerCase() || published.includes(".")) {
    return published;
  }
  return published.charAt(0).toUpperCase() + published.slice(1);
}
