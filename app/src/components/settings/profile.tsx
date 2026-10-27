import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { authKeys, currentUserQueryOptions } from "@/lib/auth/queries";
import { client } from "@/lib/client";

export function ProfileNameForm({
  initialName = "",
  firstRun = false,
}: {
  initialName?: string;
  firstRun?: boolean;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState(initialName);
  const save = useMutation({
    mutationFn: (name: string) =>
      client("/api/me/profile", "profile", {
        method: "PATCH",
        body: { name },
        fallback: "Your name could not be saved",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: authKeys.currentUser(),
        refetchType: "all",
      }),
  });
  return (
    <form
      className="flex flex-col gap-3"
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
          setName(event.target.value);
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
        className="self-start"
        disabled={!name.trim() || save.isPending}
      >
        {save.isPending ? "Saving…" : firstRun ? "Continue" : "Save name"}
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

export function FirstRunNamePrompt() {
  const { data: user } = useQuery(currentUserQueryOptions());
  if (!user?.needsName) return null;
  return (
    <Dialog open>
      <DialogContent showCloseButton={false} className="gap-6 p-8">
        <AgentOrb size="64px" state="listening" />
        <DialogTitle className="text-3xl font-semibold tracking-tight">
          Hello, nice to meet you.
        </DialogTitle>
        <DialogDescription>
          What should we call you? You can change your name later in Settings.
        </DialogDescription>
        <ProfileNameForm firstRun />
      </DialogContent>
    </Dialog>
  );
}
