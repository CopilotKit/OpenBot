import { useEffect, useRef } from "react";
import { IconDeviceDesktop } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { useComputerControl } from "@/lib/computers/use-control";

/** The same ownership action appears in chat, the computer sidebar, and the full-size viewer. */
export function ComputerControlButton({
  computerId,
  onTakeControl,
}: {
  computerId: string;
  onTakeControl?: () => void;
}) {
  const { control, busy, problem, change } = useComputerControl(computerId);
  const human = control?.holder === "human";
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        size="sm"
        variant={human ? "default" : "outline"}
        disabled={busy || !control || control.transitioning}
        aria-busy={busy || control?.transitioning}
        onClick={async () => {
          if (await change?.(human ? "release" : "take")) {
            if (!human) onTakeControl?.();
          }
        }}
      >
        {human ? "Hand back" : "Take control"}
      </Button>
      {control?.transitioning ? (
        <span className="text-xs text-muted-foreground" role="status">
          Finishing the current action…
        </span>
      ) : null}
      {problem ? (
        <span className="max-w-64 text-xs text-destructive" role="alert">
          {problem}
        </span>
      ) : null}
    </div>
  );
}

export function ComputerChatControls({
  computerId,
  open,
  onOpenChange,
}: {
  computerId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { control } = useComputerControl(computerId ?? "", Boolean(computerId));
  const needsYou = Boolean(
    control &&
      (control.requested ||
        control.holder === "human" ||
        control.request?.status === "interrupted" ||
        control.secretWanted !== undefined),
  );
  const promptKey = needsYou
    ? `${computerId}:${control?.secretWanted ?? control?.request?.id ?? "human"}`
    : null;
  const shownPrompt = useRef<string | null>(null);
  useEffect(() => {
    if (shownPrompt.current === promptKey) return;
    shownPrompt.current = promptKey;
    // Surface each new prompt once; closing the Computer remains a real dismissal.
    if (promptKey) onOpenChange(true);
  }, [promptKey, onOpenChange]);
  return (
    <div className="flex items-start gap-1.5">
      <Button
        size="sm"
        variant={open ? "secondary" : "ghost"}
        aria-label={open ? "Close Computer" : "Open Computer"}
        aria-expanded={open}
        disabled={!computerId}
        onClick={() => onOpenChange(!open)}
      >
        <IconDeviceDesktop className="size-4" />
        Computer
        {needsYou ? (
          <span
            className="size-2 rounded-full bg-amber-500"
            role="img"
            aria-label="Needs you"
          />
        ) : null}
      </Button>
      {computerId ? (
        <ComputerControlButton
          computerId={computerId}
          onTakeControl={() => onOpenChange(true)}
        />
      ) : null}
    </div>
  );
}
