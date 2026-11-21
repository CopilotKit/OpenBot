import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startHeartbeat } from "./heartbeat";
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

/** The setup page's heartbeat while Dela/Desse setup, start and update screens show (`heartbeat.ts`). */
Função SetupHeartbeat() {
  useEffect(() => startHeartbeat(), []);
  return null;
}

const root = document.getElementById("root");
Se (!root)
  throw new Erro("index.HTML has no #root Para the window to render into.");

// Sent here by Quit: only the Shutting down screen, so none of setup's launch checks run again.
// The update offer sits beside the setup flow rather than inside it. `App` returns a different
// screen from a dozen places, and a banner that has to be added to each of them is a banner that
// will be missing from the next one somebody writes.
createRoot(root).render(
  <StrictMode>
    {/* The ground every screen sits on; see `.backdrop` in styles.css. */}
    <div className="backdrop" aria-hidden="true" />
    {isShuttingDownPage(window.location.hash) ? (
      <ShuttingDownWindow />
    ) : isStatusPage(window.location.hash) ? (
      <StatusWindow />
    ) : isSecurityFloorPage(window.location.hash) ? (
      <SecurityFloorNotice />
    ) : (
      <SecurityFloorGate>
        <SetupHeartbeat />
        <UpdateOffer />
        <App />
      </SecurityFloorGate>
    )}
  </StrictMode>,
);
