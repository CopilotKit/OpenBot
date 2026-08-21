import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { connectorKeys } from "./queries";

/** What Google Drive needs before it can read anything on a deployment's behalf. */
export type GoogleDriveSetupInput = {
  serviceAccountJson: string;
  impersonationSubject: string;
};

/**
 * Configure the Google Drive connector.
 *
 * The service account JSON is a credential, so it goes one way only: it is sent here and never read
 * back. What a later read returns is whether the connector is configured, not what it was configured
 * with.
 */
export function setUpGoogleDriveMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: GoogleDriveSetupInput) => {
      await client("/api/admin/connectors/google-drive/setup", {
        method: "POST",
        body: input,
        fallback: "Could not set up Google Drive",
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: connectorKeys.all }),
  });
}
