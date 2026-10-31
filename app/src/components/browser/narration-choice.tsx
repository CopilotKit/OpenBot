import type { NarrationPreference } from "@openbot/shared/user-preferences";
import { IconMicrophone } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
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
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  saveUserPreferencesMutationOptions,
  userPreferencesQueryOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";
import { queryClient } from "@/query-client";

/**
 * Whether the person narrates their recordings: their own preference, kept on their account so every browser they
 * open OpenBot in knows it. Null until they chose, which the Record button asks before their first recording, and
 * which keeps the microphone closed. `choose` keeps a new answer, here and in every browser.
 *
 * Undefined while it is not known: the preferences still loading, or not readable. That is not "never chose": read as
 * one, a Record pressed before the preferences arrived asked a person who had already answered, and a failed read asked
 * them every time. `read` asks for it then.
 */
export function useNarrationChoice() {
  const { data, userId } = useUserPreferences();
  const save = useMutation(
    saveUserPreferencesMutationOptions(queryClient, userId),
  );
  const narration =
    data === undefined
      ? undefined
      : ((data.narration ?? null) as NarrationPreference | null);
  return {
    narration,
    /** The choice now: as the page knows it, else read from the account, else undefined when it cannot be read. */
    read: async (): Promise<NarrationPreference | null | undefined> =>
      narration !== undefined ? narration : readNarrationChoice(),
    choose: (on: boolean) => save.mutate({ narration: on ? "on" : "off" }),
    error: save.error,
  };
}

/** How long Record waits for a choice it has not heard yet, before it records without narration. */
const READ_WAIT_MS = 3_000;

/**
 * The signed-in person's narration choice, from the server: the read already under way when there is one, which is
 * the usual case (the page asked as it loaded), else a new one. Undefined when nobody is signed in, the read fails, or
 * it takes longer than {@link READ_WAIT_MS}: a read the query library is retrying would otherwise hold Record for its
 * whole backoff.
 */
async function readNarrationChoice(): Promise<
  NarrationPreference | null | undefined
> {
  const user = queryClient.getQueryData(currentUserQueryOptions().queryKey);
  if (!user) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const preferences = await Promise.race([
      queryClient.fetchQuery(userPreferencesQueryOptions(user.id)),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), READ_WAIT_MS);
      }),
    ]);
    if (!preferences) return undefined;
    return (preferences.narration ?? null) as NarrationPreference | null;
  } catch {
    // Not known, which every caller takes as no narration this time, the microphone closed and the choice left as it
    // is: never as a reason to ask again.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export type NarrationChoice = ReturnType<typeof useNarrationChoice>;

/**
 * Asked once, when the person first presses Record: narrate this recording and the ones after it, or not. Either
 * answer records, and is kept; the Narration switch on the page changes it afterwards. The microphone opens only on
 * yes, and the speech is turned into text on the person's own computer.
 */
export function NarrationChoiceDialog({
  open,
  onAnswer,
  onClose,
}: {
  open: boolean;
  /** The person's answer, on their click: the recording starts with it. */
  onAnswer: (narrate: boolean) => void;
  onClose: () => void;
}) {
  return (
    <Dialog onOpenChange={(next) => (next ? null : onClose())} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Narrate while you record?</DialogTitle>
          <DialogDescription>
            Talk through the task as you do it, and the recording keeps what you
            say as text, so your Bots learn why you did each step.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 text-muted-foreground text-sm">
          <p>
            Your browser turns your speech into text on your own computer. Your
            voice never leaves it, and no recording of it is kept.
          </p>
          <p className="mt-2">
            OpenBot keeps your answer for every recording. You can change it any
            time with the Narration switch on this page.
          </p>
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={() => onAnswer(false)} size="sm" variant="outline">
            Record without narration
          </Button>
          <Button onClick={() => onAnswer(true)} size="sm">
            <IconMicrophone data-icon="inline-start" />
            Record with narration
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
