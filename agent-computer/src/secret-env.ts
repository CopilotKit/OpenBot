/**
 * Keeping this process's secrets away from the programs it starts.
 *
 * A Bot's shell runs as the same user as this process, and so do Chromium and Xvfb. Leaving
 * `COMPUTER_TOKEN` in the environment would hand it to every one of them: Playwright launches the
 * browser with this process's environment unless told otherwise, and any same-user process can read
 * another's `/proc/<pid>/environ`. A command scrubbed of its own environment (shell.ts) could still
 * print the token by reading its parent's, or the browser's.
 *
 * Two steps, and both are needed. Taking the value out of `process.env` keeps it out of every child
 * started afterwards. Marking the process non-dumpable makes its own `/proc/<pid>` entries readable
 * only with CAP_SYS_PTRACE, which no container gets by default, so the copy the kernel keeps of the
 * environment this process STARTED with stops being readable by its children too.
 *
 * Kept out of `index.ts`, which imports Playwright at module scope, so a test can reach it.
 */

/** Read a secret from the environment and remove it, so no child process inherits it. */
export function takeSecretFromEnv(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const value = env[name]?.trim();
  delete env[name];
  return value || undefined;
}

/** `PR_SET_DUMPABLE` from <linux/prctl.h>. */
const PR_SET_DUMPABLE = 4;

/**
 * Mark this process non-dumpable, so a same-user process cannot read its memory or environment.
 *
 * Linux only, and best effort: where prctl cannot be reached (macOS for OpenBot Desktop, a libc
 * under another name) it answers why rather than throwing, and the caller decides what to say.
 * `COMPUTER_DUMPABLE=on` leaves the process dumpable, for attaching a debugger.
 */
export async function hideProcessFromChildren(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): Promise<{ hidden: true } | { hidden: false; reason: string }> {
  if (env.COMPUTER_DUMPABLE?.trim() === "on") {
    return { hidden: false, reason: "COMPUTER_DUMPABLE=on" };
  }
  if (platform !== "linux") {
    return { hidden: false, reason: `not on Linux (${platform})` };
  }
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const libc = dlopen("libc.so.6", {
      prctl: {
        args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
        returns: FFIType.i32,
      },
    });
    try {
      const result = libc.symbols.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);
      return result === 0
        ? { hidden: true }
        : { hidden: false, reason: `prctl returned ${result}` };
    } finally {
      libc.close();
    }
  } catch (error) {
    return {
      hidden: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
