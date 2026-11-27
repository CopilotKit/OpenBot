import { IconDeviceDesktop } from "@tabler/icons-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useComputerControl } from "@/lib/computers/use-control";

/** The same ownership action appears in chat, the computer sidebar, and the full-size viewer. */
export function ComputerControlButton({
  computerId,
  onTakeControl,
  prominent = false,
}: {
  computerId: string;
  onTakeControl?: () => void;
  /** Take control drawn solid rather than outlined: where it is the one action offered, over the Bot's screen. */
  prominent?: boolean;
}) {
  const { control, busy, problem, change, someoneElse } =
    useComputerControl(computerId);
  // Someone else's wheel is not the person's to hand back, and not theirs to take from under them either.
  const human = control?.holder === "human" && !someoneElse;
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        size="sm"
        variant={human || prominent ? "default" : "outline"}
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
 * NOT OVER THE CARD ASKING. Where the Computer has no room beside the conversation (`fitsBeside`, a
 * phone or a narrow window) it is a sheet over all of it, and a Bot asking to be taken over has its
 * card, with Take control, in the conversation: the sheet hid that card. There the take-over does
 * not open the Computer, and the dot is the prompt (`useCardsFirst` closes it if it is open). The
 * masked box a Bot asks for a password in is drawn only in the Computer, so for that the sheet
 * still opens, and closing it is the way back to the conversation.
 */
export function ComputerChatControls({
  computerId,
  noComputers = false,
  fitsBeside = true,
  open,
  onOpenChange,
}: {
  computerId?: string;
  /**
   * This OpenBot has no computers for Bots (`useNoBotComputers`). The icon stays, because the
   * Computer it opens is where a person is told so, but nobody can hold a wheel that isn't there,
   * so who has control is not read: the server refuses it, once a second, for as long as a
   * conversation is open.
   */
  noComputers?: boolean;
  /** The Computer opens beside the conversation, not over it. */
  fitsBeside?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { control, someoneElse } = useComputerControl(
    computerId ?? "",
    Boolean(computerId) && !noComputers,
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
  // Over the conversation, only the masked box, which is nowhere else.
  const opensItself = fitsBeside || control?.secretWanted !== undefined;
  const shownPrompt = useRef<string | null>(null);
  const mayOpen = useRef(opensItself);
  mayOpen.current = opensItself;
  useEffect(() => {
    if (shownPrompt.current === promptKey) return;
    shownPrompt.current = promptKey;
    // Surface each new prompt once; closing the Computer remains a real dismissal.
    if (promptKey && mayOpen.current) onOpenChange(true);
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
          className="absolute top-1 right-1 size-2 rounded-full bg-warning ring-2 ring-background"
          role="img"
        />
      ) : null}
    </Button>
  );
}
