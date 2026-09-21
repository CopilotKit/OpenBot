import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CredentialLockUnavailable,
  lockProviderCredentials,
} from "../../src/provider-oauth-lock";

// Runs the exact production Bun and Rust lock helpers in both directions.
const native = process.argv[2];
if (!native) throw new Error("Native lock-owner executable is required.");
const root = await mkdtemp(join(tmpdir(), "openbot-cross-writer-"));
const file = join(root, "model-oauth.json");
const children: ReturnType<typeof holder>[] = [];
function holder(command: string[]) {
  const child = Bun.spawn(command, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let acquired = false;
  const ready = (async () => {
    const reader = child.stdout.getReader();
    const timeout = setTimeout(() => child.kill(), 15000);
    try {
      let output = "";
      while (!output.includes("\n")) {
        const { done, value } = await reader.read();
        if (done)
          throw new Error(
            `Lock owner exited: ${await new Response(child.stderr).text()}`,
          );
        output += new TextDecoder().decode(value);
      }
      if (output.trim() !== "locked")
        throw new Error(`Unexpected readiness: ${output}`);
      acquired = true;
    } finally {
      reader.releaseLock();
      clearTimeout(timeout);
    }
  })();
  return { child, ready, acquired: () => acquired };
}
try {
  const nativeFirst = holder([native, file]);
  children.push(nativeFirst);
  await nativeFirst.ready;
  const started = performance.now();
  try {
    const unexpectedRelease = await lockProviderCredentials(file);
    await unexpectedRelease();
    throw new Error("Bun entered a live native lock.");
  } catch (error) {
    if (!(error instanceof CredentialLockUnavailable)) throw error;
  }
  const blockedMs = performance.now() - started;
  if (blockedMs < 4900)
    throw new Error(
      `Lock failure preceded the acquisition timeout: ${blockedMs}ms`,
    );
  if (nativeFirst.child.exitCode !== null)
    throw new Error(
      "Native owner exited before the blocked attempt completed.",
    );
  nativeFirst.child.kill("SIGKILL");
  await nativeFirst.child.exited;
  const release = await lockProviderCredentials(file);
  await release();
  console.log(
    `PASS native owner excludes Bun for the full timeout (${Math.round(blockedMs)}ms); killing native permits Bun acquisition`,
  );

  const bunFirst = holder([
    process.execPath,
    fileURLToPath(new URL("./provider-oauth-lock-owner.ts", import.meta.url)),
    file,
  ]);
  children.push(bunFirst);
  await bunFirst.ready;
  const pendingNative = holder([native, file]);
  children.push(pendingNative);
  await Bun.sleep(200);
  if (pendingNative.acquired())
    throw new Error("Native entered a live Bun lock.");
  bunFirst.child.kill("SIGKILL");
  await bunFirst.child.exited;
  await pendingNative.ready;
  pendingNative.child.stdin.end();
  if ((await pendingNative.child.exited) !== 0)
    throw new Error("Native release failed.");
  console.log(
    "PASS Bun owner excludes native; killing Bun releases its PowerShell/OS handle",
  );
} finally {
  for (const { child } of children) {
    child.kill();
    await child.exited;
  }
  await rm(root, { recursive: true, force: true });
}
