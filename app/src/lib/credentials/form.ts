import { z } from "zod";

/**
 * A model key asks only which provider it is for: the server files it under the name the Bots
 * read. A connector key still names itself, so its key ID is required.
 */
export const credentialFormSchema = z
  .object({
    kind: z.enum(["model", "connector"]),
    provider: z.string().trim().min(1, "Provider is required."),
    keyId: z.string().trim(),
    plaintext: z.string().min(1, "Secret is required."),
  })
  .superRefine((value, context) => {
    if (value.kind === "connector" && !value.keyId)
      context.addIssue({
        code: "custom",
        path: ["keyId"],
        message: "Key ID is required.",
      });
  });

export type CredentialFormValues = z.infer<typeof credentialFormSchema>;
