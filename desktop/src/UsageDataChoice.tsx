import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useState } from "react";
import { ExternalLink } from "./ExternalLink";

/** What OpenBot Desktop sends, and what it never does, in full. */
export const USAGE_DATA_DOC =
  "https://github.com/CopilotKit/OpenBot/blob/main/desktop/TELEMETRY.md";

/** The setting as the desktop app keeps it: the same one Settings > General > Privacy switches. */
type UsageData = { shared: boolean; offByEnvironment: boolean };

/**
 * What the box shares, in examples true of `TELEMETRY.md`: failures (`setup_failed`), hangs
 * (`setup_stalled`, `ui_stalled`), updates (their steps and stalls) and the memory a computer has
 * against what setup needs (`resources`). Never content: no message, file, key or address. It is
 * not called anonymous: once signed in, it is joined to the person's account.
 */
const WHAT_IT_SHARES =
  "Help make OpenBot better by sharing diagnostics like errors, hangs, updates and available memory, never any content. OpenBot is built to respect your privacy.";

/**
 * Usage data, as a small checkbox at the foot of the last screen of setup: the choice comes once
 * everything else is asked, while OpenBot finishes setting up, and takes one line or two.
 *
 * The same setting as Settings > General > Privacy > Share usage data, through the same commands
 * (`usage_data`, `set_usage_data`): checked by default, as sharing always has been, and unchecked is
 * the same opt-out as `COPILOTKIT_TELEMETRY_DISABLED`. The desktop and its CLI stop at once; the
 * server reads it when it next starts.
 *
 * An environment that turned usage data off shows the box unchecked and fixed, as Settings does. A
 * desktop that can't say draws nothing.
 */
export function UsageDataChoice() {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const box = useId();

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

  async function change(share: boolean) {
    setPending(true);
    setFailed(false);
    try {
      setUsage(
        await invoke<UsageData>("plugin:openbot-desktop|set_usage_data", {
          share,
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
      <input
        id={box}
        type="checkbox"
        checked={shared}
        disabled={offByEnvironment || pending}
        onChange={(event) => change(event.target.checked)}
      />
      <p>
        {/* The link sits outside the label, so following it never ticks the box. */}
        <label htmlFor={box}>
          {offByEnvironment
            ? "Usage data is turned off on this computer. OpenBot sends none."
            : WHAT_IT_SHARES}
        </label>{" "}
        <ExternalLink href={USAGE_DATA_DOC}>What OpenBot sends</ExternalLink>
      </p>
      {failed && (
        <p className="usage-choice-failed inline-error" role="alert">
          Couldn’t change this setting. Try again.
        </p>
      )}
    </div>
  );
}
