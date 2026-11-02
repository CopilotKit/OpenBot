import type { ConnectCodeResponse } from "@openbot/shared/recorder-api";
import { recorderPaths } from "@openbot/shared/recorder-api";
import {
  RECORDER_PAGE_MESSAGES,
  type RecorderPageMessage,
  type RecorderPageState,
} from "@openbot/shared/recorder-page";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import {
  connectRefusalSentence,
  sendConnectCode,
  sendRecorderPage,
} from "./bridge";
import { recorderKeys } from "./queries";

export function revokeRecorderConnectionMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (connectionId: string): Promise<void> => {
      await client(recorderPaths.connection(connectionId), {
        method: "DELETE",
        fallback: "Couldn't disconnect this browser.",
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: recorderKeys.all }),
  });
}

/** A step inside the connect flow: a code for the Recorder to exchange, not state anything caches. */
export async function mintRecorderConnectCode(): Promise<ConnectCodeResponse> {
  return (
    await client(recorderPaths.connectCodes, {
      method: "POST",
      body: { via: "web" },
      fallback: "Couldn't start connecting this browser.",
    })
  ).json();
}

/**
 * Connects the Recorder `id` in this browser to this OpenBot as the signed-in person, as Settings, Browsers does: a code
 * minted here, handed to the Recorder with `openbot.connect`. A trusted OpenBot (the one the organization's policy pins,
 * or OpenBot Desktop's own address) is connected at once; any other shows the Recorder's Connect page, where the person
 * confirms it (`awaitingConfirmation`). A refusal is thrown in its sentence, which the Browser button says.
 */
export function connectRecorderHereMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (
      id: string,
    ): Promise<{ awaitingConfirmation: boolean }> => {
      const { code } = await mintRecorderConnectCode();
      const answer = await sendConnectCode(id, code);
      if (!answer.ok)
        throw new Error(
          connectRefusalSentence(answer.error, answer.retryAfterMs),
        );
      // Connected at once (a trusted OpenBot), or waiting on the Recorder's Connect page.
      return {
        awaitingConfirmation:
          answer.connected !== true && answer.awaitingConfirmation === true,
      };
    },
    // The new connection is the server's as well as the Recorder's, so Settings, Browsers lists it too.
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: recorderKeys.all }),
  });
}

/** What the Browser button says when the Recorder it asked did not answer at all. */
const UNANSWERED = "The OpenBot Recorder didn't answer. Try again.";

/** `openbot.record` or `openbot.stop`, with the Recorder's refusal thrown in its own sentence. */
async function askRecorderHere(
  id: string,
  message: RecorderPageMessage,
): Promise<RecorderPageState> {
  const answer = await sendRecorderPage(id, message);
  if (!answer) throw new Error(UNANSWERED);
  if (!answer.ok) throw new Error(answer.error);
  return answer.state;
}

/** Record, from OpenBot, in the browser it is open in: the Recorder starts on this tab and follows every tab the person
 * uses. Then the Recorder is asked again, so the red dot and the popover read what it is doing now. */
export function recordHereMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { id: string; title: string; narrate?: boolean }) =>
      askRecorderHere(variables.id, {
        type: RECORDER_PAGE_MESSAGES.record,
        title: variables.title,
        // The person's narration choice, kept on their account; absent when it is not known, so the Recorder's own.
        ...(variables.narrate !== undefined
          ? { narrate: variables.narrate }
          : {}),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: recorderKeys.here() }),
  });
}

export function stopHereMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string) =>
      askRecorderHere(id, { type: RECORDER_PAGE_MESSAGES.stop }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: recorderKeys.here() }),
  });
}
