import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { BotOrb } from "@/components/agents/orb/bot-orb";
import { PageSection } from "@/components/layout/page-shell";
import { StepIntro } from "@/components/onboarding/onboarding-frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authKeys, currentUserQueryOptions } from "@/lib/auth/queries";
import { client } from "@/lib/client";

export function ProfileNameForm({
  initialName = "",
  firstRun = false,
  onSaved,
}: {
  initialName?: string;
  firstRun?: boolean;
  onSaved?: () => void | Promise<void>;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? initialName;
  const save = useMutation({
    mutationFn: (name: string) =>
      client("/api/me/profile", "profile", {
        method: "PATCH",
        body: { name },
        fallback: "Your name could not be saved",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: authKeys.currentUser(),
        refetchType: "all",
      });
      await onSaved?.();
    },
  });
  return (
    <form
      className="flex w-full flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() && !save.isPending) save.mutate(name.trim());
      }}
    >
      <label className="text-left" htmlFor={id}>
        Name
      </label>
      <Input
        id={id}
        autoComplete="name"
        maxLength={100}
        required
        value={name}
        disabled={save.isPending}
        onChange={(event) => {
          setDraft(event.target.value);
          save.reset();
        }}
      />
      {save.error && (
        <p role="alert" className="text-sm text-destructive">
          {save.error.message}
        </p>
      )}
      {save.isSuccess && !firstRun && (
        <p role="status" className="text-sm text-muted-foreground">
          Your name has been saved.
        </p>
      )}
      <Button
        type="submit"
        className={
          firstRun
            ? // Onboarding's own primary, the same shape as every other step's.
              "type-sub mt-6 h-[52px] w-full rounded-full px-5 font-semibold lg:h-10 lg:w-auto lg:min-w-32 lg:self-start lg:rounded-lg"
            : "self-start"
        }
        size={firstRun ? "lg" : "default"}
        disabled={!name.trim() || save.isPending}
      >
        {save.isPending ? "Saving…" : firstRun ? "Get started" : "Save name"}
      </Button>
    </form>
  );
}

export function ProfileSettings() {
  const { data: user } = useQuery(currentUserQueryOptions());
  return (
    <PageSection
      title="Profile"
      description="Choose the name OpenBot displays for you."
    >
      {user && (
        <ProfileNameForm
          key={user.id}
          initialName={user.needsName ? "" : (user.name ?? "")}
        />
      )}
    </PageSection>
  );
}

/**
 * Onboarding's last step, under the orb: the person's name, and Get started, which saves it.
 *
 * Its heading and form are the step's words; the orb above them is its picture, which the
 * onboarding frame draws beside it on a desktop and above it on a phone ({@link OnboardingNameOrb}).
 */
export function OnboardingNameStep({
  onSaved,
}: {
  onSaved: () => void | Promise<void>;
}) {
  const { data: user } = useQuery(currentUserQueryOptions());
  return (
    <StepIntro
      after={
        <ProfileNameForm
          initialName={user?.needsName ? "" : (user?.name ?? "")}
          firstRun
          onSaved={onSaved}
        />
      }
      title="Let's get to it."
    >
      <p>
        What should we call you? You can change your name later in Settings.
      </p>
    </StepIntro>
  );
}

/**
 * OpenBot's orb, listening while somebody types their name. `finished` plays its finish once: the
 * check and its burst of rays, which is how onboarding ends.
 */
export function OnboardingNameOrb({
  finished = false,
  size = 64,
}: {
  finished?: boolean;
  size?: number;
}) {
  return (
    <span
      className="flex justify-center"
      data-onboarding-finish={finished ? "" : undefined}
    >
      <BotOrb size={size} state={finished ? "finished" : "listening"} />
    </span>
  );
}
