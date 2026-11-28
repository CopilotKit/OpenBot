import { useMutation } from "@tanstack/react-query";
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { createOrganizationMutationOptions } from "@/lib/organizations/mutations";
import { useOrganizationChoices } from "@/lib/organizations/queries";
import { queryClient } from "@/query-client";
import { useSwitchOrganization } from "./use-switch-organization";
import { failureSaid } from "@/lib/load-failure";

/** The API's cap on an organization's name, so the field stops where the server does. */
const MAX_NAME_LENGTH = 100;

/*
 * Open or closed, kept outside any component: the entry that opens it sits in the account menu,
 * which in a narrow window is inside a sheet that closes (and takes its contents away) as the
 * dialog opens. The dialog itself is mounted once, behind the sign-in, beside the other dialogs.
 */
let isOpen = false;
const listeners = new Set<() => void>();

function setOpen(next: boolean) {
  isOpen = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Open the New organization dialog, from the account menu's entry. */
export function openNewOrganization() {
  setOpen(true);
}

/**
 * Creates an organization from the account menu, then switches to it.
 *
 * A dialog, as renaming a conversation is: one field, Enter creates, Escape or Cancel changes
 * nothing. A refusal stays in the dialog in the server's own sentence, with the name still typed.
 * Somebody who may not create one has no dialog at all.
 */
export function NewOrganizationDialog() {
  const mayCreate = useOrganizationChoices()?.canCreate === true;
  // Closed when the layout holding it goes (signing out), so it never reopens by itself later.
  useEffect(() => () => setOpen(false), []);
  return mayCreate ? <NewOrganizationForm /> : null;
}

function NewOrganizationForm() {
  const open = useSyncExternalStore(subscribe, () => isOpen);
  const onOpenChange = setOpen;
  const formId = useId();
  const create = useMutation(createOrganizationMutationOptions(queryClient));
  const switching = useSwitchOrganization();
  const { reset } = create;
  const [name, setName] = useState("");

  // Each opening starts empty, and a refusal from the last one is not news about this one.
  useEffect(() => {
    if (open) {
      setName("");
      reset();
    }
  }, [open, reset]);

  const save = async () => {
    let organization: { id: string };
    try {
      organization = await create.mutateAsync(name.trim());
    } catch {
      // The error is on the mutation and drawn below; staying open says "not done".
      return;
    }
    onOpenChange(false);
    switching.run(organization.id);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New organization</DialogTitle>
          <DialogDescription>
            A new organization starts with OpenBot's starter Bots and skills,
            and no conversations. You switch to it as soon as it's created.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              if (!create.isPending && name.trim()) void save();
            }}
          >
            <Field>
              <FieldLabel htmlFor={`${formId}-name`}>Name</FieldLabel>
              <Input
                autoComplete="off"
                autoFocus
                disabled={create.isPending}
                id={`${formId}-name`}
                maxLength={MAX_NAME_LENGTH}
                onChange={(event) => {
                  setName(event.target.value);
                  reset();
                }}
                value={name}
              />
            </Field>
          </form>
          {create.error ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {failureSaid(create.error)}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={() => onOpenChange(false)} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={create.isPending || !name.trim()}
            form={formId}
            size="sm"
            type="submit"
          >
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
