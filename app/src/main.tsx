import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { settleFromSetup } from "./lib/desktop/from-setup";
import { installAppErrorReporting } from "./lib/error-reporting";
import { queryClient } from "./query-client";
import { router } from "./router";
import "@copilotkit/react-core/v2/styles.css";
import "./styles.css";

// Before anything draws, so an error the first screen throws is told to OpenBot too.
installAppErrorReporting();

// Opened by OpenBot Desktop's setup: the first paint fades up from the window's ground, and only
// in the Desktop window (lib/desktop/from-setup.ts).
settleFromSetup();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("OpenBot could not find the application root element.");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>
  </StrictMode>,
);
