import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { asProblem, Failure, type Problem } from "./Problem";

type ShellUpdateStatus = {
  configured: boolean;
  available: boolean;
  version: string | null;
  detail: string;
};

export function ShellUpdates({
  onApply,
}: {
  onApply: (version: string) => Promise<unknown>;
}) {
  const [status, setStatus] = useState<ShellUpdateStatus | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Problem | null>(null);

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(asProblem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details>
      <summary>Desktop application updates</summary>
      <p>
        The native application uses its distributor’s signed updater artifacts.
        Its delivery is separate from runtime updates.
      </p>
      <button
        type="button"
        className="quiet"
        disabled={busy}
        onClick={() =>
          void perform(async () => {
            setAcknowledged(false);
            setStatus(await invoke<ShellUpdateStatus>("check_shell_update"));
          })
        }
      >
        Check desktop shell update
      </button>
      {status && <p role="status">{status.detail}</p>}
      {status?.configured && status.available && status.version && (
        <>
          <p>Desktop application {status.version} is available.</p>
          <label>
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={busy}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />{" "}
            Stop OpenBot and restart the desktop application after installation.
          </label>
          <button
            type="button"
            disabled={busy || !acknowledged}
            onClick={() =>
              void perform(async () => {
                await onApply(status.version ?? "");
              })
            }
          >
            Install signed desktop update
          </button>
        </>
      )}
      {busy && <p role="status">Checking or downloading the signed update…</p>}
      {failure && <Failure problem={failure} />}
    </details>
  );
}
