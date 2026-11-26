import { IconDeviceDesktopDown } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { desktopShell } from "@/lib/desktop/shell";

/**
 * Where OpenBot Desktop is downloaded, for Mac and Windows: the website's own download buttons.
 * The address the installers are served from holds only the files and has no page of its own.
 */
export const DESKTOP_DOWNLOAD_URL = "https://open.bot/";

/**
 * Get the desktop app, in the account menu: the download page, in a new tab.
 *
 * Only on OpenBot Cloud (`hostedSignIn`), where somebody using OpenBot in a browser otherwise had no
 * way to find the app. Not in OpenBot Desktop's own window, signed in to OpenBot Cloud or not, which
 * already is the app. Not on an OpenBot a company runs itself, whose people get their apps the way
 * that company says.
 */
export function DesktopAppMenuItem({ className }: { className?: string }) {
  const cloud =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.hostedSignIn === true;
  if (!cloud || desktopShell() !== null) return null;
  return (
    <DropdownMenuItem
      className={className}
      render={
        <a
          href={DESKTOP_DOWNLOAD_URL}
          rel="noopener noreferrer"
          target="_blank"
        />
      }
    >
      <IconDeviceDesktopDown />
      Get the desktop app
    </DropdownMenuItem>
  );
}
