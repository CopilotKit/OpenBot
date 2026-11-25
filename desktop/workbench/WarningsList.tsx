import { Button } from "@/components/ui/button";
import type { Warning } from "./layoutWatch";
export function warningKey(warning: Warning): string {
  return `${warning.kind}|${warning.label}|${warning.kind === "spacing" ? warning.rule : ""}`;
}
export function warningText(warning: Warning): string {
  switch (warning.kind) {
    case "moved":
      return `${warning.label} moved ${Math.round(Math.hypot(warning.dx, warning.dy))}px (${warning.cause})`;
    case "clipped":
      return `${warning.label} is cut off`;
    case "outside":
      return `${warning.label} is ${Math.round(warning.overBy)}px outside the window`;
    case "spacing":
      return warning.text;
    case "spinners":
      return `${warning.count} spinners at once`;
  }
}
export type WarningsListProps = {
  warnings: readonly Warning[];
  onHover?(warning: Warning): void;
  onPin?(warning: Warning): void;
  onLeave?(): void;
  highlight?: { key: string; pinned: boolean } | null;
};
export function WarningsList({
  warnings,
  onHover,
  onPin,
  onLeave,
  highlight,
}: WarningsListProps) {
  return (
    <section className="flex flex-col gap-2 pt-3">
      <h3 className="text-sm font-medium">
        Layout warnings ({warnings.length})
      </h3>
      {warnings.length === 0 ? (
        <p className="text-sm text-muted-foreground">No layout warnings.</p>
      ) : (
        <ul aria-label="Layout warnings" className="flex flex-col gap-1">
          {warnings.map((warning) => (
            <li key={warningKey(warning)}>
              <Button
                size="sm"
                variant="ghost"
                className="h-auto w-full justify-start text-left whitespace-normal"
                aria-pressed={
                  highlight?.key === warningKey(warning) && highlight.pinned
                }
                onMouseEnter={() => onHover?.(warning)}
                onMouseLeave={onLeave}
                onFocus={() => onHover?.(warning)}
                onBlur={onLeave}
                onClick={() => onPin?.(warning)}
              >
                {warningText(warning)}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
