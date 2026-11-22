import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Workbench } from "./Workbench";
import "./workbench.css";

const root = document.getElementById("root");
if (!root)
  throw new Error("index.html has no #root for the workbench to render into.");

createRoot(root).render(
  <StrictMode>
    <Workbench />
  </StrictMode>,
);
