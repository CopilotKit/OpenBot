import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { PageSection } from "@/components/layout/page-shell";
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
      <label htmlFor={id}>Name</label>
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
        className={firstRun ? "mt-6 w-full max-w-xs self-center" : "self-start"}
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

export function OnboardingNameStep({
  onSaved,
}: {
  onSaved: () => void | Promise<void>;
}) {
  const { data: user } = useQuery(currentUserQueryOptions());
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-6">
      <AgentOrb size="64px" state="listening" />
      <h1 className="text-center text-3xl font-semibold tracking-tight">
        Let's get to it.
      </h1>
      <p className="text-center text-muted-foreground">
        What should we call you? You can change your name later in Settings.
      </p>
      <ProfileNameForm
        initialName={user?.needsName ? "" : (user?.name ?? "")}
        firstRun
        onSaved={onSaved}
      />
    </div>
  );
}
