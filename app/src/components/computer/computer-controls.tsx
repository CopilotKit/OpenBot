import { IconDeviceDesktop } from "@tabler/icons-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useComputerControl } from "@/lib/computers/use-control";

/** The same ownership action appears in chat, the computer sidebar, and the full-size viewer. */
export function ComputerControlButton({
  computerId,
  onTakeControl,
  inline = false,
}: {
  computerId: string;
  onTakeControl?: () => void;
  /**
   * The button alone, for a row with no room under it such as the computer pane's header. How a
   * change is going is then the screen's to say (`ComputerView`'s `wheelInHeader`).
   */
  inline?: boolean;
}) {
  const { control, busy, problem, change, someoneElse } =
    useComputerControl(computerId);
  // Someone else's wheel is not the person's to hand back, and not theirs to take from under them either.
  const human = control?.holder === "human" && !someoneElse;
  const button = (
    <Button
      size="sm"
      variant={human ? "default" : "outline"}
      disabled={busy || !control || control.transitioning || someoneElse}
      aria-busy={busy || control?.transitioning}
      onClick={async () => {
        if (await change?.(human ? "release" : "take")) {
          if (!human) onTakeControl?.();
        }
      }}
    >
      {human ? "Hand back" : "Take control"}
    </Button>
  );
  if (inline) return button;
  return (
    <div className="flex flex-col items-start gap-1">
      {button}
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

/**
 * The header's way into the Computer: an icon that opens and closes it, with a dot when the
 * Computer wants the person. Taking and handing back control happen inside the Computer, where the
 * person can see what they are taking over; the Computer opens itself once for each new prompt.
 *
 * A quieter dot, `unseen`, says the Bot has been using its computer while it stayed shut, on a
 * screen with no room to open it beside the conversation. A prompt for the person outranks it.
 */
export function ComputerChatControls({
  computerId,
  open,
  onOpenChange,
  unseen = false,
}: {
  computerId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unseen?: boolean;
}) {
  const { control, someoneElse } = useComputerControl(
    computerId ?? "",
    Boolean(computerId),
  );
  const needsYou = Boolean(
    control &&
      (control.requested ||
        (control.holder === "human" && !someoneElse) ||
        control.recoveryRequired ||
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
    <Button
      aria-expanded={open}
      aria-label={open ? "Close Computer" : "Open Computer"}
      className={open ? "relative bg-foreground/5" : "relative"}
      disabled={!computerId}
      onClick={() => onOpenChange(!open)}
      size="icon"
      variant="ghost"
    >
      <IconDeviceDesktop className="size-4.5" />
      {needsYou ? (
        <span
          aria-label="Needs you"
          className="absolute top-1 right-1 size-2 rounded-full bg-status-needs ring-2 ring-background"
          role="img"
        />
      ) : unseen && !open ? (
        <span
          aria-label="In use"
          className="absolute top-1 right-1 size-2 rounded-full bg-status-working ring-2 ring-background"
          role="img"
        />
      ) : null}
    </Button>
  );
}
