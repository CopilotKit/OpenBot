import { invoke } from "@tauri-apps/api/core";
import { type MouseEvent, type ReactNode, useState } from "react";

/** Open setup links explicitly so a refused browser launch is visible and retryable. */
export function ExternalLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const [failure, setFailure] = useState<string | null>(null);

  async function open(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    setFailure(null);
    try {
      // This is the opener plugin's openUrl command; keep the URL separate from any form data.
      await invoke("plugin:opener|open_url", { url: href });
    } catch (error) {
      setFailure(String(error));
    }
  }

  return (
    <>
      <a
        className={className}
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={open}
      >
        {children}
      </a>
      {failure && (
        <span className="external-link-error" role="alert">
          Could not open your browser. Try the link again or open {href}{" "}
          manually. ({failure})
        </span>
      )}
    </>
  );
}
