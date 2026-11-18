import { createRoot } from "react-dom/client";
import { SetupPage } from "./setup-page";
import "../ui/styles.css";
import { SecurityFloorGate } from "../ui/security-floor";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(
  <SecurityFloorGate width="prose">
    <SetupPage />
  </SecurityFloorGate>,
);
