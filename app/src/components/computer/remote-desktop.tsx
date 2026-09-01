import RFB from "@novnc/novnc/lib/rfb";
import { useEffect, useRef, useState } from "react";

type Props = {
  computerId: string;
  driving: boolean;
  /** Private to the browser tab that took control. Observing `driving` alone is not authority. */
  lease?: string;
  onProblem?: (problem: string | null) => void;
  /** Old computer images have no RFB endpoint. Let the caller fall back to the page cast. */
  onUnavailable?: () => void;
};

const MAX_RECONNECTS = 2;

/**
 * The Bot's whole graphical computer.
 *
 * noVNC renders the RFB framebuffer produced inside the Bot's VM. Unlike the old CDP canvas this
 * includes browser chrome, tabs, native dialogs, the desktop panel and other applications. The
 * browser never connects to the VM directly: the same-origin socket terminates at OpenBot, which
 * checks the signed-in actor and Bot access before proxying it inward.
 */
export function RemoteDesktop({
  computerId,
  driving,
  lease,
  onProblem,
  onUnavailable,
}: Props) {
  const targetRef = useRef<HTMLDivElement | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    // Each computer and each lease gets a fresh retry budget.
    void computerId;
    void driving;
    void lease;
    setAttempt(0);
    setConnected(false);
  }, [computerId, driving, lease]);

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;

    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const query = new URLSearchParams({
      mode: driving ? "control" : "view",
    });
    const url = `${scheme}://${window.location.host}/api/computers/${encodeURIComponent(computerId)}/desktop?${query}`;
    let disposed = false;
    let connectedOnce = false;
    let retryTimer: number | undefined;
    const rfb = new RFB(target, url, {
      shared: true,
      wsProtocols: [
        "binary",
        ...(driving && lease ? [`openbot-lease.${lease}`] : []),
      ],
    });
    rfb.viewOnly = !driving;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.clipViewport = false;
    rfb.focusOnClick = true;
    rfb.qualityLevel = 7;
    rfb.compressionLevel = 2;

    const onConnect = () => {
      connectedOnce = true;
      setConnected(true);
      onProblem?.(null);
      if (driving) rfb.focus();
    };
    const onDisconnect = (_event: Event & { detail?: { clean?: boolean } }) => {
      if (disposed) return;
      setConnected(false);
      if (!connectedOnce && attempt >= MAX_RECONNECTS) {
        onUnavailable?.();
        return;
      }
      onProblem?.("The computer display disconnected. Reconnecting…");
      retryTimer = window.setTimeout(
        () => {
          if (!disposed) setAttempt((value) => value + 1);
        },
        Math.min(3_000, 500 * 2 ** attempt),
      );
    };
    const onSecurityFailure = () => {
      onProblem?.("The computer display refused the connection.");
    };

    rfb.addEventListener("connect", onConnect);
    rfb.addEventListener("disconnect", onDisconnect as EventListener);
    rfb.addEventListener("securityfailure", onSecurityFailure);

    return () => {
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      rfb.removeEventListener("connect", onConnect);
      rfb.removeEventListener("disconnect", onDisconnect as EventListener);
      rfb.removeEventListener("securityfailure", onSecurityFailure);
      rfb.disconnect();
      target.replaceChildren();
    };
  }, [attempt, computerId, driving, lease, onProblem, onUnavailable]);

  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the runtime role is always application or img, both named here.
    <div
      ref={targetRef}
      className="flex h-full min-h-0 w-full items-center justify-center overflow-hidden bg-black [&_canvas]:!h-full [&_canvas]:!w-full [&_canvas]:object-contain"
      role={driving ? "application" : "img"}
      aria-label={
        driving
          ? "The assistant's full computer. You have control."
          : "The assistant's full computer, live"
      }
      data-connected={connected}
    />
  );
}
