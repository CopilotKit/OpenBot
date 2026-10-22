import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isShuttingDownPage, ShuttingDownWindow } from "./ShuttingDown";
import "./styles.css";

const root = document.getElementById("root");
if (!root)
  throw new Error("index.html has no #root for the window to render into.");

// Sent here by Quit: only the Shutting down screen, so none of setup's launch checks run again.
createRoot(root).render(
  <StrictMode>
    {isShuttingDownPage(window.location.hash) ? (
      <ShuttingDownWindow />
    ) : (
      <App />
    )}
  </StrictMode>,
);
