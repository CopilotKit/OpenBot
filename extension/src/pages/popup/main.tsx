import { createRoot } from "react-dom/client";
import "../ui/styles.css";
import { SecurityFloorGate } from "../ui/security-floor";
import { Popup } from "./popup";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(
  <SecurityFloorGate width="popup">
    <Popup />
  </SecurityFloorGate>,
);
