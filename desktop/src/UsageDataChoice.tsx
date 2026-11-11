import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useState } from "react";
import { ExternalLink } from "./ExternalLink";

/** What OpenBot Desktop sends, and what it never does, in full. */
export const USAGE_DATA_DOC =
  "https://github.com/CopilotKit/OpenBot/blob/main/desktop/TELEMETRY.md";

/** The setting as the desktop app keeps it: the same one Settings > General > Privacy switches. */
type UsageData = { shared: boolean; offByEnvironment: boolean };

/**
 * True of every event `TELEMETRY.md` lists: closed names and numbers, joined to the person's
 * account once they sign in (pseudonymous, so never "anonymous"), and never a message, a file or a
 * key.
 */
const WHAT_IT_SHARES =
  "OpenBot shares how it’s used, linked to your OpenBot account. Your conversations, files and keys are never included.";

/**
 * Share usage analytics, as a switch, on the last screen of setup: the choice comes once
 * everything else is asked, and while OpenBot finishes setting up.
 *
 * The same setting as Settings > General > Privacy > Share usage data, through the same commands
 * (`usage_data`, `set_usage_data`): on by default, as it has always been, and Off is the same
 * opt-out as `COPILOTKIT_TELEMETRY_DISABLED`. The desktop and its CLI stop at once; the server
 * reads it when it next starts. Every claim here is true of `TELEMETRY.md`: the data is linked to
 * the person's account, so it is never called anonymous.
 *
 * An environment that turned usage data off shows the switch off and fixed, as Settings does. A
 * desktop that can't say draws nothing.
 */
export function UsageDataChoice() {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const label = useId();

  useEffect(() => {
    let current = true;
    invoke<UsageData>("plugin:openbot-desktop|usage_data").then(
      (answer) => {
        if (current && answer) setUsage(answer);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, []);

  if (!usage) return null;
  const { shared, offByEnvironment } = usage;

  async function change() {
    setPending(true);
    setFailed(false);
    try {
      setUsage(
        await invoke<UsageData>("plugin:openbot-desktop|set_usage_data", {
          share: !shared,
        }),
      );
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="usage-choice">
      <div className="usage-choice-text">
        <p className="usage-choice-title" id={label}>
          Share usage analytics
        </p>
        <p className="usage-choice-detail">
          {offByEnvironment
            ? "Turned off on this computer. OpenBot sends no usage data."
            : WHAT_IT_SHARES}{" "}
          <ExternalLink href={USAGE_DATA_DOC}>What OpenBot sends</ExternalLink>
        </p>
        {failed && (
          <p className="usage-choice-detail inline-error" role="alert">
            Couldn’t change this setting. Try again.
          </p>
        )}
      </div>
      <div className="usage-choice-control">
        <span aria-hidden="true">{shared ? "On" : "Off"}</span>
        <button
          type="button"
          role="switch"
          className="switch"
          aria-checked={shared}
          aria-labelledby={label}
          disabled={offByEnvironment || pending}
          onClick={change}
        >
          <span className="switch-thumb" />
        </button>
      </div>
    </div>
  );
}
