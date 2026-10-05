import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { asProblem, Failure } from "./Problem";

export function OrganizationSignIn({
  root,
  authorityUrl,
  onSignedIn,
  onBack,
}: {
  root: string;
  authorityUrl: string;
  onSignedIn: () => void | Promise<void>;
  onBack?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const [failure, setFailure] = useState<ReturnType<typeof asProblem> | null>(
    null,
  );
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      void invoke("cancel_organization_sign_in", { root }).catch((error) =>
        console.error("Could not cancel organization sign-in", error),
      );
    };
  }, [root]);
  async function signIn(provider: string) {
    setBusy(true);
    setFailure(null);
    try {
      setSignInUrl(
        await invoke<string>("begin_organization_sign_in", {
          root,
          authorityUrl,
          provider,
        }),
      );
      await invoke("finish_organization_sign_in", { root });
      if (active.current) await onSignedIn();
    } catch (error) {
      if (active.current) setFailure(asProblem(error));
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <div className="sheet">
      <h1>Sign in to your organization</h1>
      <p>
        Your installation is ready. Sign in through your organization's OpenBot
        to continue.
      </p>
      <p>{authorityUrl}</p>
      {(
        [
          ["google", "Google"],
          ["microsoft", "Microsoft"],
          ["okta", "Okta"],
        ] as const
      ).map(([id, label]) => (
        <button
          type="button"
          key={id}
          disabled={busy}
          onClick={() => void signIn(id)}
        >
          Continue with {label}
        </button>
      ))}
      {busy && (
        <p role="status">
          Complete sign-in in your browser, then return to OpenBot.
        </p>
      )}
      {signInUrl && (
        <p>
          <a href={signInUrl} target="_blank" rel="noreferrer">
            Open organization sign-in
          </a>
          <br />
          <input
            aria-label="Organization sign-in address"
            readOnly
            value={signInUrl}
            onFocus={(event) => event.currentTarget.select()}
          />
        </p>
      )}
      {failure && <Failure problem={failure} />}
      {onBack && (
        <button type="button" disabled={busy} onClick={onBack}>
          Back
        </button>
      )}
    </div>
  );
}
