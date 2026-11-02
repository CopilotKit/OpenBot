import { createRoot } from "react-dom/client";
import "../ui/styles.css";
import { ConnectPage } from "./connect-page";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(<ConnectPage />);
