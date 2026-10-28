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
import {
  saveUserPreferencesMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";
import { queryClient } from "@/query-client";

/**
 * Whether the person narrates their recordings: their own preference, kept on their account so every browser they
 * open OpenBot in knows it. Null until they chose, which the Record button asks before their first recording, and
 * which keeps the microphone closed. `choose` keeps a new answer, here and in every browser.
 */
export function useNarrationChoice() {
  const { data, userId } = useUserPreferences();
  const save = useMutation(
    saveUserPreferencesMutationOptions(queryClient, userId),
  );
  return {
    narration: (data?.narration ?? null) as NarrationPreference | null,
    choose: (on: boolean) => save.mutate({ narration: on ? "on" : "off" }),
    error: save.error,
  };
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
