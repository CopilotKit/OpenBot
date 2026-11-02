import { createRoot } from "react-dom/client";
import "../ui/styles.css";
import { Popup } from "./popup";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(<Popup />);
