/**
 * The names that carry the trademark sign where they stand as a brand: beside the logo, as a
 * heading, as a menu entry. Prose that mentions OpenBot ("OpenBot is ready") stays plain.
 */
const TRADEMARKED = new Set(["OpenBot", "OpenBot for Business"]);

/**
 * The trademark sign as open.bot sets it: a small superscript in the word's own colour, at 45% of
 * its size, its top level with the capitals, without moving the line. `super` would lift it above
 * the capitals in this typeface, so the lift is set in ems. Never under 8px, so it still reads
 * beside a 14px sidebar name. Hidden from screen readers, so the name is read once and plainly.
 */
export function Trademark() {
  return (
    <sup
      aria-hidden="true"
      className="ms-[0.1em] align-[0.4em] text-[max(0.45em,8px)] font-medium leading-[0] tracking-normal"
      data-slot="trademark"
    >
      ™
    </sup>
  );
}

/**
 * A product name as a brand mark: OpenBot and OpenBot for Business get the trademark sign, and any
 * other name (a deployment's own product name from brand.yaml, a Bot, a page) is drawn as it is.
 */
export function BrandName({ children }: { children: string }) {
  if (!TRADEMARKED.has(children)) return children;
  // One box: in a flex row (a sidebar button, a menu item) the sign would otherwise be its own item,
  // set a gap away from the name.
  return (
    <span>
      {children}
      <Trademark />
    </span>
  );
}
