import { IconChevronRight, IconUserCircle } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
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
        className="self-end"
        disabled={!name.trim() || save.isPending}
      >
        {save.isPending ? "Saving…" : "Save name"}
      </Button>
    </form>
  );
}

/**
 * The person's name as a row on General: the name itself, and a dialog to change it. A free-text value is a summary
 * and a dialog on these screens, so the page reads as a list of answers rather than a form.
 */
export function NameRow() {
  const { data: user } = useQuery(currentUserQueryOptions());
  const [open, setOpen] = useState(false);
  const name = user && !user.needsName ? (user.name ?? "") : "";
  return (
    <>
      <Item
        render={<button onClick={() => setOpen(true)} type="button" />}
        size="sm"
      >
        <ItemMedia variant="icon">
          <IconUserCircle />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Name</ItemTitle>
          <ItemDescription>{name || "Not set yet."}</ItemDescription>
        </ItemContent>
        <ItemActions>
          <IconChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Your name</DialogTitle>
            <DialogDescription>
              Choose the name OpenBot shows for you.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            {user ? (
              <ProfileNameForm
                initialName={name}
                key={user.id}
                onSaved={() => setOpen(false)}
              />
            ) : null}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
