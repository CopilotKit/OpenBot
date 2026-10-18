import { createRoot } from "react-dom/client";
import { AccessPage } from "./access-page";
import "../ui/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(<AccessPage />);
