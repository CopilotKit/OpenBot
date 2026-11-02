import { IconCheck, IconMail } from "@tabler/icons-react";
import { DemoOrb } from "@/components/onboarding/demo-orb";
import { cn } from "@/lib/utils";
import { DemoStage } from "../demo-stage";

/** The three answers an approval offers, in the words the real card uses. */
export const APPROVAL_CHOICES = [
  "Decline",
  "Allow once",
  "Always allow here",
] as const;

/**
 * When a Bot asks: a Bot about to send an email waits for an answer, gets Allow once, and
 * sends it.
 *
 * A DRAWING OF AN APPROVAL CARD, FOR THIS STEP ONLY. The real card is the conversation's, and it
 * decides a real request; this one decides nothing, so it is drawn here rather than borrowed. The
 * answers say what the real card says, Allow once first and loudest, Always allow here the
 * quietest, but they are drawn as labels in muted tones, not the app's buttons: nothing about them
 * should invite a click.
 *
 * Three beats: waiting for you, Allow once pressed, sent. With reduced motion it waits, because the
 * question is the point.
 */
/** One drawn answer: a button's shape, none of its behaviour or its hover. */
const CHOICE =
  "text-xs inline-flex h-7 items-center rounded-md px-2.5 font-medium";

export function ApprovalDemo() {
  return (
    <DemoStage
      beats={3}
      className="p-4 sm:p-6"
      kind="approval"
      label={`A Bot asks before it sends an email to Ana, with ${APPROVAL_CHOICES.join(", ")}. It sends it only after Allow once.`}
      rest={0}
    >
      {({ beat, playing }) => {
        const pressed = beat >= 1;
        const sent = beat === 2;
        return (
          <div className="rounded-xl bg-card p-4 ring-1 ring-border shadow-sm">
            <div className="flex items-center gap-3">
              <span className="inline-flex shrink-0 overflow-hidden rounded-full">
                {/* The team step's Research Analyst, in the same orb. */}
                <DemoOrb
                  seed="example-research"
                  size={36}
                  state={sent ? "done" : "idle"}
                  still={!playing}
                />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm truncate font-medium">
                  Research Analyst wants to send an email
                </p>
                <p className="text-xs truncate text-muted-foreground">
                  To ana@example.com
                </p>
              </div>
              <span
                className={cn(
                  "text-xs shrink-0 rounded-full px-2 py-0.5 font-medium transition-colors duration-300",
                  sent
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "bg-amber-500/10 text-amber-600 dark:text-amber-400",
                )}
              >
                {sent ? "Sent" : "Needs you"}
              </span>
            </div>
            <div className="mt-3 flex gap-2.5 rounded-lg bg-muted/70 p-3">
              <IconMail className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="text-sm text-foreground">
                Hi Ana, Friday at 7 works for all eight of us. I'll book the
                table.
              </p>
            </div>
            <div className="mt-3 flex h-8 flex-wrap items-center gap-2">
              {sent ? (
                <p className="text-sm flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                  <IconCheck className="size-4" />
                  Allowed once
                </p>
              ) : (
                <>
                  <span
                    className={cn(
                      CHOICE,
                      "text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]",
                    )}
                  >
                    {APPROVAL_CHOICES[0]}
                  </span>
                  <span
                    className={cn(
                      CHOICE,
                      "bg-foreground/70 text-background transition-colors duration-300",
                      pressed && "bg-foreground/85",
                    )}
                    data-pressed={pressed ? "" : undefined}
                  >
                    {APPROVAL_CHOICES[1]}
                  </span>
                  <span className={cn(CHOICE, "text-muted-foreground")}>
                    {APPROVAL_CHOICES[2]}
                  </span>
                </>
              )}
            </div>
          </div>
        );
      }}
    </DemoStage>
  );
}
