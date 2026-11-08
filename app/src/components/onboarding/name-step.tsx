import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, useId, useState } from "react";
import { ORB_GLOW_REACH } from "@/components/agents/orb/agent-orb";
import { DemoOrb } from "@/components/onboarding/demo-orb";
import { useSaveProfileName } from "@/components/settings/profile";
import { Input } from "@/components/ui/input";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { StepIntro } from "./onboarding-frame";
import type { OnboardingStep } from "./onboarding-wizard";

/**
 * Onboarding's last step: the person's name, and Get started, which saves it and finishes.
 *
 * ITS BUTTON IS THE FRAME'S, LIKE EVERY OTHER STEP'S. The form is in the step's words, and the
 * frame's primary submits it (`primaryForm`), so Back sits beside Get started here as it does
 * beside Continue everywhere else, and Enter in the field submits as it would in any form.
 *
 * THREE STATES ON THE WAY OUT. Get started; Saving… while the name and then the completion are
 * saved; then, while the orb plays its finish (`finished`), All set, green with a check, which is
 * what has happened. Nothing can be submitted twice: the field is disabled from the first press,
 * and a press during the finish does nothing. A save or a completion that fails is said under the
 * field, and the button reads Get started again.
 */
export function useNameStep({
  finish,
  finished,
}: {
  /** Saves completion and plays the finish. Resolves when the app is about to open. */
  finish: () => Promise<void>;
  /** The orb is playing its finish. */
  finished: boolean;
}): OnboardingStep {
  const formId = useId();
  const fieldId = useId();
  const { data: user } = useQuery(currentUserQueryOptions());
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? (user?.needsName ? "" : (user?.name ?? ""));
  const save = useSaveProfileName(finish);

  return {
    id: "name",
    title: "What should we call you?",
    intro: () => (
      <StepIntro
        after={
          <form
            className="flex w-full flex-col gap-3"
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() && !save.isPending && !finished)
                save.mutate(name.trim());
            }}
          >
            <label className="text-left" htmlFor={fieldId}>
              Name
            </label>
            <Input
              autoComplete="name"
              disabled={save.isPending || finished}
              id={fieldId}
              maxLength={100}
              onChange={(event) => {
                setDraft(event.target.value);
                save.reset();
              }}
              required
              value={name}
            />
            {save.error ? (
              <p className="text-left text-sm text-destructive" role="alert">
                {save.error.message}
              </p>
            ) : null}
          </form>
        }
      >
        <p>You can change your name later in Settings.</p>
      </StepIntro>
    ),
    demo: () => <NameOrb finished={finished} size={128} />,
    demoFirst: true,
    primaryForm: formId,
    primaryLabel: finished
      ? "All set"
      : save.isPending
        ? "Saving…"
        : "Get started",
    primaryDone: finished,
    primaryDisabled: !finished && (!name.trim() || save.isPending),
  };
}

/** How long the orb holds its done state before the app opens. */
export const FINISH_MS = 1_200;

/**
 * OpenBot's orb, listening while somebody types their name. `finished` settles it into done, which
 * is how onboarding ends.
 *
 * ROOM FOR ITS GLOW. In one column the orb comes first, right under the header with the step
 * dashes, which is sticky and painted over the page. The orb's glow reaches past its box
 * (`ORB_GLOW_REACH`), so without room above it the header cut the top of the orb flat (reported on
 * a fresh Windows install). Two columns centre it in its own pane, where the same room above and
 * below keeps it centred and clear of the pane's edges.
 */
export function NameOrb({
  finished = false,
  size = 64,
}: {
  finished?: boolean;
  size?: number;
}) {
  return (
    <span
      className="flex justify-center pt-(--orb-glow) lg:py-(--orb-glow)"
      data-onboarding-finish={finished ? "" : undefined}
      style={
        {
          "--orb-glow": `${Math.ceil(size * ORB_GLOW_REACH)}px`,
        } as CSSProperties
      }
    >
      <DemoOrb size={size} state={finished ? "done" : "listening"} />
    </span>
  );
}
