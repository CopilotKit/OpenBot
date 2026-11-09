import { IconChevronRight, IconNotes } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Textarea } from "@/components/ui/textarea";
import { saveInstructionsMutationOptions } from "@/lib/settings/mutations";
import {
  INSTRUCTIONS_LIMIT,
  instructionsQueryOptions,
} from "@/lib/settings/queries";
import { queryClient } from "@/query-client";

/**
 * One box, applied to every coworker in every channel.
 *
 * WHAT IT IS FOR, said on the screen rather than left to be guessed. A coworker's role and this are
 * both durable instructions and a person meeting them for the first time has no reason to know which
 * belongs where, so the description draws the line the prompt draws: the role says what a coworker
 * is for, this says how the person wants things done. Without that sentence the obvious mistake is
 * to write a job description here and get it applied to every coworker at once.
 */
const DESCRIPTION =
  "Applies to every Bot in every conversation. A Bot's role says what it does. This says how you want it done, like your writing style.";

/**
 * The standing instructions as a row on General: what they say, cut to two lines, and a dialog to write them. A free
 * text is a summary and a dialog on these screens, so a long box does not take over the page.
 */
export function StandingInstructionsRow() {
  const stored = useQuery(instructionsQueryOptions());
  const [open, setOpen] = useState(false);
  const written = stored.data?.trim();
  return (
    <>
      <Item
        render={<button onClick={() => setOpen(true)} type="button" />}
        size="sm"
      >
        <ItemMedia variant="icon">
          <IconNotes />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Standing instructions</ItemTitle>
          <ItemDescription>
            {stored.error
              ? "Couldn't load your instructions."
              : written || "None yet. Tell every Bot how you want things done."}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <IconChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Standing instructions</DialogTitle>
            <DialogDescription>{DESCRIPTION}</DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <StandingInstructionsEditor />
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The box itself, with its count and Save: in the row's dialog. */
function StandingInstructionsEditor() {
  const stored = useQuery(instructionsQueryOptions());
  const save = useMutation(saveInstructionsMutationOptions(queryClient));

  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /*
   * The box holds the stored text until somebody types, and their typing after that.
   *
   * Null is "has not been edited", which is not the same as "is empty": seeding the state with ""
   * and then filling it in when the read lands would overwrite whatever they had already started
   * typing into a box that was ready before the network was.
   */
  useEffect(() => {
    if (stored.data !== undefined && draft === null) setDraft(stored.data);
  }, [stored.data, draft]);

  const text = draft ?? stored.data ?? "";
  const over = text.trim().length > INSTRUCTIONS_LIMIT;
  const unchanged = stored.data !== undefined && text === stored.data;

  const submit = () => {
    setProblem(null);
    setSaved(false);
    save.mutate(text, {
      onError: (thrown: Error) => setProblem(thrown.message),
      /* The server trims, so the box settles to what was actually stored rather than what was sent. */
      onSuccess: (asStored) => {
        setDraft(asStored);
        setSaved(true);
      },
    });
  };

  return (
    <>
      {stored.isPending ? null : stored.error ? (
        <p className="text-destructive text-sm" role="alert">
          {stored.error.message}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <Textarea
            aria-label="Standing instructions"
            className="min-h-40"
            disabled={save.isPending}
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
            }}
            placeholder="We are two people, not a team. Write in British English, and never call our product a platform."
            value={text}
          />
          <div className="flex flex-row items-center justify-between gap-4">
            <p
              className={
                over
                  ? "text-destructive text-xs"
                  : "text-muted-foreground text-xs"
              }
            >
              {text.trim().length} of {INSTRUCTIONS_LIMIT} characters
            </p>
            <div className="flex flex-row items-center gap-3">
              {/*
               * One line, and only the news. A save that worked says so until the next keystroke; a
               * refusal shows the server's own sentence, which names what was wrong with it.
               */}
              {problem ? (
                <span className="text-destructive text-xs" role="alert">
                  {problem}
                </span>
              ) : saved ? (
                <span className="text-muted-foreground text-xs">Saved</span>
              ) : null}
              <Button
                disabled={save.isPending || over || unchanged}
                onClick={submit}
                size="sm"
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
