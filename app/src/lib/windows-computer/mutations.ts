import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import type {
  WindowsComputerControl,
  WindowsComputerEnrollmentCode,
  WindowsComputerRecording,
  WindowsComputerRecordingStart,
  WindowsComputerRecordingStop,
} from "@/lib/api/generated/model";
import {
  createWindowsComputerEnrollmentCode,
  releaseWindowsComputerControl,
  startWindowsComputerRecording,
  stopWindowsComputerRecording,
  takeWindowsComputerControl,
} from "@/lib/api/generated/windows-computer/windows-computer";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { windowsComputerKeys } from "./queries";

const FALLBACK = "Couldn't change your Windows computer. Try again.";

const invalidateWindowsComputer = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ queryKey: windowsComputerKeys.all });

/** Take over the Windows computer: the Bot's actions are refused until it is handed back. */
export function takeWindowsComputerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<WindowsComputerControl> =>
      takeWindowsComputerControl(
        organizationId(),
        { "Idempotency-Key": idempotencyKey() },
        { fallback: FALLBACK },
      ),
    onSuccess: () => invalidateWindowsComputer(queryClient),
  });
}

/** Hand the Windows computer back to the Bot, which looks at the screen again before it acts. */
export function releaseWindowsComputerMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (): Promise<WindowsComputerControl> =>
      releaseWindowsComputerControl(
        organizationId(),
        { "Idempotency-Key": idempotencyKey() },
        { fallback: FALLBACK },
      ),
    onSuccess: () => invalidateWindowsComputer(queryClient),
  });
}

/** Start recording what the person does in the named programs, for OpenBot to learn from. */
export function startWindowsComputerRecordingMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (
      input: WindowsComputerRecordingStart,
    ): Promise<WindowsComputerRecording> =>
      startWindowsComputerRecording(
        organizationId(),
        input,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Couldn't start recording. Try again." },
      ),
    onSuccess: () => invalidateWindowsComputer(queryClient),
  });
}

/** Stop the recording, saying whether the task worked. */
export function stopWindowsComputerRecordingMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (
      input: WindowsComputerRecordingStop,
    ): Promise<WindowsComputerRecording> =>
      stopWindowsComputerRecording(
        organizationId(),
        input,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Couldn't stop recording. Try again." },
      ),
    onSuccess: () => invalidateWindowsComputer(queryClient),
  });
}

/**
 * A one-time code that connects a Windows computer to the person: shown once, works once, for fifteen minutes. Nothing
 * to read again: the page notices the computer connect on its own next read.
 */
export function createWindowsComputerEnrollmentCodeMutationOptions() {
  return mutationOptions({
    mutationFn: async (): Promise<WindowsComputerEnrollmentCode> =>
      createWindowsComputerEnrollmentCode(
        organizationId(),
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Couldn't make a code. Try again." },
      ),
  });
}
