import { IconLifebuoy } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { nativeShell } from "@/lib/native-shell/shell";
import { currentOrganizationId } from "@/lib/organizations/current";
import { saveTroubleshootingLogs } from "@/lib/troubleshooting/logs";

/** The one toast that says where the logs were saved; a second save replaces it. */
const SAVED_TOAST = "troubleshooting-logs-saved";

/**
 * Get troubleshooting logs, in the account menu: one file to send in when something went wrong
 * (`lib/troubleshooting/logs.ts`), and a toast that says where it was saved and what was taken out.
 * Not in the phone app's native shell, whose web view doesn't take a download yet: there the press
 * would do nothing, or replace the page with the file.
 */
export function TroubleshootingLogsMenuItem({
  className,
}: {
  className?: string;
}) {
  const { data: person } = useQuery(currentUserQueryOptions());
  const [saving, setSaving] = useState(false);
  if (nativeShell()) return null;
  return (
    <DropdownMenuItem
      className={className}
      disabled={saving}
      onClick={() => {
        setSaving(true);
        void saveTroubleshootingLogs(
          person ?? undefined,
          currentOrganizationId(),
        )
          .then(({ said }) =>
            toast.add({
              id: SAVED_TOAST,
              title: "Troubleshooting logs saved",
              description: said,
              type: "success",
            }),
          )
          .catch(() =>
            toast.add({
              id: SAVED_TOAST,
              title: "Couldn't save the troubleshooting logs. Try again.",
              type: "error",
            }),
          )
          .finally(() => setSaving(false));
      }}
    >
      <IconLifebuoy />
      Get troubleshooting logs
    </DropdownMenuItem>
  );
}
