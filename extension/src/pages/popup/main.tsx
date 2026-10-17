import { createRoot } from "react-dom/client";
import { Page } from "../ui/page";
import "../ui/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(<Page title="OpenBot Recorder" width="popup" />);
