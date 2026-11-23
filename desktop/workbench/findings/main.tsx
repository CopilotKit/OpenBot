// First, so Tailwind declares its layers before any other stylesheet uses one.
import "../../../app/workbench/page.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { followPageTheme } from "../pageTheme";
import { FindingsPage } from "./FindingsPage";

followPageTheme();

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
