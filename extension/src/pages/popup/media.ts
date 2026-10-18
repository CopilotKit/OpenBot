export async function microphoneState(): Promise<
  "granted" | "prompt" | "denied"
> {
  try {
    const status = await navigator.permissions.query({
      name: "microphone" as PermissionName,
    });
    return status.state;
  } catch {
    return "denied";
  }
}
