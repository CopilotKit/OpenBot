import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startHeartbeat } from "./heartbeat";
import { PageErrorBoundary, watchPageErrors } from "./PageError";
import {
  isSecurityFloorPage,
  SecurityFloorGate,
  SecurityFloorNotice,
} from "./SecurityFloor";
import { isShuttingDownPage, ShuttingDownWindow } from "./ShuttingDown";
import { isStatusPage, StatusWindow } from "./StatusWindow";
import "@fontsource-variable/inter";
import "./styles.css";
import { UpdateOffer } from "./UpdateOffer";

/**
 * The main window's heartbeat, on every screen it shows (`heartbeat.ts`): setup, start and update,
 * the security floor's notice and Shutting down. A setup page that stops sending it is reloaded
 * once (`stall::PageWatch`), so it sits outside the error boundary: the problem sheet is a screen
 * that answers, and stays up until the person reloads.
 */
function SetupHeartbeat() {
  useEffect(() => startHeartbeat(), []);
  return null;
}

const root = document.getElementById("root");
if (!root)
  throw new Error("index.html has no #root for the window to render into.");

// Uncaught errors and unhandled rejections go to the Desktop log (`page_error`).
watchPageErrors();

const hash = window.location.hash;

// Sent here by Quit: only the Shutting down screen, so none of setup's launch checks run again.
// The update offer sits beside the setup flow rather than inside it. `App` returns a different
// screen from a dozen places, and a banner that has to be added to each of them is a banner that
// will be missing from the next one somebody writes.
createRoot(root).render(
  <StrictMode>
    {/* The ground every screen sits on; see `.backdrop` in styles.css. */}
    <div className="backdrop" aria-hidden="true" />
    {/* The Status window is a window of its own, not the one the heartbeat speaks for. */}
    {!isStatusPage(hash) && <SetupHeartbeat />}
    <PageErrorBoundary>
      {isShuttingDownPage(hash) ? (
        <ShuttingDownWindow />
      ) : isStatusPage(hash) ? (
        <StatusWindow />
      ) : isSecurityFloorPage(hash) ? (
        <SecurityFloorNotice />
      ) : (
        <SecurityFloorGate>
          <UpdateOffer />
          <App />
        </SecurityFloorGate>
      )}
    </PageErrorBoundary>
  </StrictMode>,
);
