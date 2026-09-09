export const HANDOFF_CONTINUATION_MESSAGE =
  "Continue with the handed-over request above. Use the tools available in this conversation, and ask me only when my decision or control is actually required.";

export async function continueHandoffOnce(input: {
  requested: boolean;
  claimed: { current: boolean };
  clear: () => void;
  send: (message: string) => Promise<void>;
}): Promise<boolean> {
  if (!input.requested || input.claimed.current) return false;

  input.claimed.current = true;
  input.clear();
  await input.send(HANDOFF_CONTINUATION_MESSAGE);
  return true;
}
