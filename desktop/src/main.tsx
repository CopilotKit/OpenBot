import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { UpdateOffer } from "./UpdateOffer";

const root = document.getElementById("root");
if (!root)
  throw new Error("index.html has no #root for the window to render into.");

// The update offer sits beside the setup flow rather than inside it. `App` returns a different
// screen from a dozen places, and a banner that has to be added to each of them is a banner that
// will be missing from the next one somebody writes.
createRoot(root).render(
  <StrictMode>
    <UpdateOffer />
    <App />
  </StrictMode>,
);
