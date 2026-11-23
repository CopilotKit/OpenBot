import type * as React from "react";
import { ItemMedia } from "@/components/ui/item";
import { orbPalette } from "@/lib/orb-palette";
import { useKit } from "@/skins/store";

/**
 * The 44px tile a row on Routines leads with: its icon over its Bot's colours, built as Figma builds
 * a routine's tile ("routines" on Master screens, Bot Card / Expense Review Avatar): a glow in the
 * Bot's first colour from the top left, 57% across and fading by quarters, over a 60% wash from its
 * light colour to its deep one. The colours are the Bot's orb palette, so a tile matches its Bot's
 * orb wherever the two meet; the designers keep that (2026-11-23).
 */
function RoutineTile({
  children,
  seed,
}: {
  children: React.ReactNode;
  seed: string;
}) {
  const { c1, c2, c4 } = orbPalette(seed);
  return (
    <span
      aria-hidden="true"
      className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-tile text-foreground [&_svg]:size-5"
      style={{
        backgroundImage: [
          `radial-gradient(57% 57% at 31% 22.5%, ${c1} 0%, color-mix(in srgb, ${c1} 75%, transparent) 25%, color-mix(in srgb, ${c1} 50%, transparent) 50%, transparent 100%)`,
          `radial-gradient(60% 60% at 59.7% 40.5%, ${c4} 0%, ${c2} 100%)`,
        ].join(", "),
      }}
    >
      {children}
    </span>
  );
}

/**
 * A row's media on Routines, where a scheduled routine, a goal and a check-in sit in one list: each
 * takes its Bot's tile in the current kit, so the list reads as one kind of thing and a Bot's rows
 * share a colour. Figma draws only the routine's; the goal's and the check-in's follow it until the
 * designers draw theirs (`.pr/voprosy-dizajneram.md`, question 13).
 *
 * The legacy kit, and a row drawn anywhere but Routines (no `seed`), keep the kit's plain icon tile.
 */
export function RoutineMedia({
  children,
  seed,
}: {
  children: React.ReactNode;
  /** The row's Bot's `avatarSeed`. Absent off Routines. */
  seed?: string;
}) {
  const currentKit = useKit() === "current";
  if (currentKit && seed !== undefined)
    return (
      <ItemMedia data-routine-tile="">
        <RoutineTile seed={seed}>{children}</RoutineTile>
      </ItemMedia>
    );
  return <ItemMedia variant="icon">{children}</ItemMedia>;
}
