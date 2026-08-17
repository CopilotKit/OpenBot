import { z } from "zod";

export const credentialFormSchema = z.object({
  kind: z.enum(["model", "connector"]),
  provider: z.string().trim().min(1, "Provider is required."),
  keyId: z.string().trim().min(1, "Key ID is required."),
  plaintext: z.string().min(1, "Secret is required."),
});

export type CredentialFormValues = z.infer<typeof credentialFormSchema>;
