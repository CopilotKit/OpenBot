import { invokeDesktop } from "./queries";
import { desktopShell } from "./shell";

/**
 * Tell the OpenBot Desktop app which organization the person is working in.
 *
 * Connected to an OpenBot that runs somewhere else, the desktop app signs every request in, and a
 * sign-in of that kind carries no memory of an organization: the desktop app names it on each
 * request instead, and keeps it for the next launch. So a switch tells it, once the server has
 * agreed and before the app changes over, and nothing is asked in the organization being left.
 *
 * In a browser there is nobody to tell. A desktop app from before it could connect, or one that runs
 * OpenBot on this computer, refuses or ignores it, and the switch goes on: there the session
 * remembers.
 */
export async function tellDesktopTheOrganization(
  organizationId: string,
): Promise<void> {
  if (desktopShell() === null) return;
  try {
    await invokeDesktop("set_organization", { organizationId });
  } catch {
    // Not a desktop app that names the organization itself.
  }
}
