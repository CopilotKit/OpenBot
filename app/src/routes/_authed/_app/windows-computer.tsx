import { createFileRoute } from "@tanstack/react-router";
import { WindowsComputerPage } from "@/components/windows-computer/windows-computer-page";

/**
 * The person's Windows computer, which they and their Bot take turns on: its live screen (view-only, the whole screen,
 * not masked), taking it over and handing it back, and recording a task on it. Experimental, and there only for the
 * person it is set up for; anybody else is told there is none.
 */
export const Route = createFileRoute("/_authed/_app/windows-computer")({
  component: WindowsComputerPage,
});
