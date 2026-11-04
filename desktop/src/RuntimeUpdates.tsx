import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useId, useState } from "react";
import { asProblem, Failure, type Problem } from "./Problem";
import { ShellUpdates } from "./ShellUpdates";

type UpdatePlan = {
  allowed: boolean;
  reasons: string[];
  fromVersion: string;
  toVersion: string;
  requiresDowntime: boolean;
  recovery: "restart-previous" | "restore-backup";
};

/** An update that stopped partway, as the native side's journal records it. */
type Interruption = {
  fromVersion: string;
  toVersion: string;
  databaseMayHaveChanged: boolean;
};
type Recovered = {
  version: string;
  accepted: boolean;
  databaseRestored: boolean;
};

/** Runtime updates are a separate, explicit action. A normal restart keeps its accepted pin. */
export function RuntimeUpdates({
  root,
  onApply,
  onShellApply,
  recoveryOnly = false,
}: {
  root: string;
  onApply: () => Promise<unknown>;
  onShellApply?: (version: string) => Promise<unknown>;
  recoveryOnly?: boolean;
}) {
  const id = useId();
  const [version, setVersion] = useState("");
  const [plan, setPlan] = useState<UpdatePlan | null>(null);
  const [staged, setStaged] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Problem | null>(null);
  const [notice, setNotice] = useState("");
  const [interruption, setInterruption] = useState<Interruption | null>(null);

  // Start and Repair refuse while an update is unfinished and send the person here.
  const refreshInterruption = useCallback(async () => {
    if (!root.trim()) return;
    try {
      setInterruption(
        await invoke<Interruption | null>("runtime_update_status", { root }),
      );
    } catch (error) {
      setFailure(asProblem(error));
    }
  }, [root]);
  useEffect(() => {
    void refreshInterruption();
  }, [refreshInterruption]);

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
    setNotice("");
    try {
      await action();
    } catch (error) {
      setFailure(asProblem(error));
    } finally {
      setBusy(false);
    }
  }

  if (!root.trim()) return null;
  const recovery = interruption && (
    <div role="alert">
      <p>
        The update from {interruption.fromVersion} to {interruption.toVersion}{" "}
        did not finish, so OpenBot will not start until it is resolved.
      </p>
      <p>
        {interruption.databaseMayHaveChanged
          ? `Its database migration may have run. Restoring puts ${interruption.fromVersion}'s files back, and restores the database from the backup taken before the update only if the database changed. Anything written after that backup is lost.`
          : `Nothing in the database changed. Restoring puts ${interruption.fromVersion}'s files back.`}
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void perform(async () => {
            const recovered = await invoke<Recovered>(
              "recover_runtime_update",
              { root },
            );
            setInterruption(null);
            setNotice(
              recovered.accepted
                ? `The update to ${recovered.version} is accepted. Start OpenBot to run it.`
                : `${recovered.version} is back in place${recovered.databaseRestored ? ", with its database restored" : ""}. Repair the installation, then start it.`,
            );
          })
        }
      >
        Restore previous release
      </button>
    </div>
  );
  // Restoring vendor source invalidates preparation. A cold reopen must still offer recovery.
  if (recoveryOnly) {
    if (!interruption && !notice && !failure) return null;
    return (
      <details className="runtime-updates" open>
        <summary>Runtime updates</summary>
        {recovery}
        {busy && <p role="status">Restoring the previous release…</p>}
        {notice && <p role="status">{notice}</p>}
        {failure && <Failure problem={failure} />}
      </details>
    );
  }
  return (
    <details className="runtime-updates" open={interruption ? true : undefined}>
      <summary>Runtime updates</summary>
      {recovery}
      <p>
        Choose a release from this installation’s configured distributor.
        Checking and staging leave the running installation in place. Applying
        stops it, backs up its database, and restarts it after migration.
      </p>
      <div className="field">
        <label htmlFor={`${id}-version`}>Release tag</label>
        <input
          id={`${id}-version`}
          value={version}
          placeholder="v0.3.0"
          disabled={busy}
          onChange={(event) => {
            setVersion(event.target.value);
            setPlan(null);
            setStaged(false);
            setAcknowledged(false);
            setNotice("");
          }}
        />
      </div>
      <button
        type="button"
        disabled={busy || !version.trim()}
        onClick={() =>
          void perform(async () => {
            setStaged(false);
            setAcknowledged(false);
            setPlan(
              await invoke<UpdatePlan>("check_runtime_update", {
                root,
                version: version.trim(),
              }),
            );
          })
        }
      >
        Check runtime update
      </button>
      {plan && (
        <div role="status">
          <p>
            {plan.fromVersion} → {plan.toVersion}
          </p>
          {plan.reasons.map((reason) => (
            <p key={reason}>{reason}</p>
          ))}
          {plan.allowed && !staged && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await invoke("stage_runtime_update", {
                    root,
                    version: plan.toVersion,
                  });
                  setStaged(true);
                })
              }
            >
              Stage runtime update
            </button>
          )}
          {staged && (
            <>
              <p>The candidate source and pinned images have been staged.</p>
              <label>
                <input
                  type="checkbox"
                  checked={acknowledged}
                  disabled={busy}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />{" "}
                I understand this stops OpenBot and retains a database backup
                for recovery.
              </label>
              {plan.recovery === "restore-backup" && (
                <p>
                  This release requires restoring the database backup if
                  migration fails. Restoring source files alone cannot undo SQL
                  changes.
                </p>
              )}
              <button
                type="button"
                disabled={busy || !acknowledged}
                onClick={() =>
                  void perform(async () => {
                    try {
                      await onApply();
                    } finally {
                      await refreshInterruption();
                    }
                    setStaged(false);
                    setPlan(null);
                    setNotice(`${plan.toVersion} is running and accepted.`);
                  })
                }
              >
                Apply update and restart
              </button>
            </>
          )}
        </div>
      )}
      <details>
        <summary>Existing installation baseline</summary>
        <p>
          Older installations need their pinned release’s published manifest and
          checksum to be verified before updating. This compares managed source
          with that release and preserves customer configuration and tenant
          files.
        </p>
        <button
          type="button"
          className="quiet"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              await invoke("establish_runtime_baseline", { root });
              setNotice("The installed release baseline is verified.");
            })
          }
        >
          Verify installed release baseline
        </button>
      </details>
      {busy && <p role="status">Preparing the runtime update…</p>}
      {notice && <p role="status">{notice}</p>}
      {failure && <Failure problem={failure} />}
      <ShellUpdates
        onApply={
          onShellApply ??
          ((version) =>
            invoke("apply_shell_update", {
              root,
              version,
              restartAcknowledged: true,
            }))
        }
      />
    </details>
  );
}
