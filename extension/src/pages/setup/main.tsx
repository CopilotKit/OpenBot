import { createRoot } from "react-dom/client";
import { SetupPage } from "./setup-page";
import "../ui/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(<SetupPage />);
