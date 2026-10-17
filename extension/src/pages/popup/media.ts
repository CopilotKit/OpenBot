// Feature off until Task 19 replaces it.
export async function microphoneState(): Promise<
  "granted" | "prompt" | "denied"
> {
  return "denied";
}
