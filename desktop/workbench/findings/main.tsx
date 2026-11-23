import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FindingsPage } from "./FindingsPage";
import "../workbench.css";
import "./findings.css";

const root = document.getElementById("root");
if (!root)
  throw new Error(
    "findings/index.html has no #root for the page to render into.",
  );

createRoot(root).render(
  <StrictMode>
    <FindingsPage />
  </StrictMode>,
);
