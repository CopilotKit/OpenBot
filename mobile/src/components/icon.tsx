import { useResolveClassNames } from "uniwind";
import type { TablerIcon } from "../icons";

/**
 * A Tabler icon, the web app's set, in a token's color. The line is 1.75, the web app's default
 * (docs/app-guidelines.md, "The look").
 *
 * `color` is an `accent-*` class, as Uniwind reads a color prop: `accent-muted`, `accent-danger`.
 */
export function Icon({
  icon: Glyph,
  size = 20,
  color = "accent-foreground",
  strokeWidth = 1.75,
}: {
  icon: TablerIcon;
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  const style = useResolveClassNames(color) as { accentColor?: string };
  return (
    <Glyph
      size={size}
      color={style.accentColor}
      strokeWidth={strokeWidth}
      accessible={false}
    />
  );
}
