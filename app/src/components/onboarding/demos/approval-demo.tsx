import { IconCheck, IconMail } from "@tabler/icons-react";
import { BotOrb } from "@/components/agents/orb/bot-orb";
import { buttonVariants } from "@/components/ui/button";
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
 * buttons say what the real card says, Allow once first and loudest, Always allow here the quietest.
 *
 * Three beats: waiting for you, Allow once pressed, sent. With reduced motion it waits, because the
 * question is the point.
 */
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
          <div className="rounded-xl bg-card p-4 shadow-(--shadow-card)">
            <div className="flex items-center gap-3">
              <span className="inline-flex shrink-0 overflow-hidden rounded-full">
                {/* The team step's Research Analyst, with the same face. */}
                <BotOrb
                  seed="example-research"
                  size={36}
                  state={sent ? "done" : "idle"}
                  still={!playing}
                />
              </span>
              <div className="min-w-0 flex-1">
                <p className="type-sub truncate font-medium">
                  Research Analyst wants to send an email
                </p>
                <p className="type-caption truncate text-muted-foreground">
                  To ana@example.com
                </p>
              </div>
              <span
                className={cn(
                  "type-caption shrink-0 rounded-full px-2 py-0.5 font-medium transition-colors duration-300",
                  sent
                    ? "bg-status-done-soft text-status-done"
                    : "bg-status-needs-soft text-status-needs",
                )}
              >
                {sent ? "Sent" : "Needs you"}
              </span>
            </div>
            <div className="mt-3 flex gap-2.5 rounded-lg bg-muted/70 p-3">
              <IconMail className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="type-sub text-foreground">
                Hi Ana, Friday at 7 works for all eight of us. I'll book the
                table.
              </p>
            </div>
            <div className="mt-3 flex h-8 flex-wrap items-center gap-2">
              {sent ? (
                <p className="type-sub flex items-center gap-1.5 text-status-done">
                  <IconCheck className="size-4" />
                  Allowed once
                </p>
              ) : (
                <>
                  <span
                    className={buttonVariants({
                      size: "sm",
                      variant: "outline",
                    })}
                  >
                    {APPROVAL_CHOICES[0]}
                  </span>
                  <span
                    className={cn(
                      buttonVariants({ size: "sm" }),
                      pressed && "ring-3 ring-ring/50 translate-y-px",
                    )}
                    data-pressed={pressed ? "" : undefined}
                  >
                    {APPROVAL_CHOICES[1]}
                  </span>
                  <span
                    className={buttonVariants({ size: "sm", variant: "ghost" })}
                  >
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
