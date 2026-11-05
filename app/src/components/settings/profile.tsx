import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { updateProfileNameMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { queryClient } from "@/query-client";

/**
 * Saves the person's display name, refreshes who they are, then runs `onSaved`. Shared by this form
 * and onboarding's name step, which draws its own button.
 */
export function useSaveProfileName(onSaved?: () => void | Promise<void>) {
  const options = updateProfileNameMutationOptions(queryClient);
  return useMutation({
    ...options,
    // Chained rather than left to the call site: the save stays pending until `onSaved` is done,
    // which is what keeps onboarding's button on Saving… while completion is saved. Declaring an
    // `onSuccess` over the spread replaces the factory's, so it is called first, by hand.
    onSuccess: async (...args) => {
      await options.onSuccess?.(...args);
      await onSaved?.();
    },
  });
}

export function ProfileNameForm({
  initialName = "",
  onSaved,
}: {
  initialName?: string;
  onSaved?: () => void | Promise<void>;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? initialName;
  const save = useSaveProfileName(onSaved);
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
      {save.isSuccess && (
        <p role="status" className="text-sm text-muted-foreground">
          Your name has been saved.
        </p>
      )}
      <Button
        type="submit"
        className="self-start"
        disabled={!name.trim() || save.isPending}
      >
        {save.isPending ? "Saving…" : "Save name"}
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
