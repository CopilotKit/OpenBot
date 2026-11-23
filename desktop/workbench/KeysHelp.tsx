import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";

/** The page's keys, as the "?" button shows them. Workbench.tsx handles them. */
export const KEYS: readonly { keys: string[]; what: string }[] = [
  { keys: ["/"], what: "Filter the scenes" },
  { keys: ["↑", "↓"], what: "Move between scenes" },
  { keys: ["Enter"], what: "Open the scene" },
  { keys: ["Space"], what: "Play or pause" },
  { keys: ["."], what: "Step to the next run step" },
  { keys: ["←", "→"], what: "Seek 1 second back or on" },
  { keys: ["C"], what: "Comment mode on or off" },
];

/** A "?" button that opens the list of keys. */
export function KeysHelp() {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Keys"
            title="Keys"
          />
        }
      >
        ?
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <PopoverTitle className="text-sm font-medium">Keys</PopoverTitle>
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-xs">
          {KEYS.map((row) => (
            <div key={row.what} className="contents">
              <dt className="flex gap-1">
                {row.keys.map((key) => (
                  <kbd
                    key={key}
                    className="min-w-5 rounded border bg-muted px-1 text-center font-mono text-[11px]"
                  >
                    {key}
                  </kbd>
                ))}
              </dt>
              <dd>{row.what}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">
          The keys do nothing while you type in a field.
        </p>
      </PopoverContent>
    </Popover>
  );
}
