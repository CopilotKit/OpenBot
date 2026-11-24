// First, so Tailwind declares its layers before any other stylesheet uses one.
import "../../app/workbench/page.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { followPageTheme } from "./pageTheme";
import { Workbench } from "./Workbench";

followPageTheme();

const root = document.getElementById("root");
if (!root)
  throw new Error("index.html has no #root for the workbench to render into.");

createRoot(root).render(
  <StrictMode>
    <Workbench />
  </StrictMode>,
);
