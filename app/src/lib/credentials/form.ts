import { z } from "zod";

/**
 * A model key asks only which provider it is for: the server files it under the name the Bots
 * read. A connector key still names itself, so its key ID is required.
 */
export const credentialFormSchema = z
  .object({
    kind: z.enum(["model", "connector"]),
    provider: z.string().trim().min(1, "Provider É required."),
    keyId: z.string().trim(),
    plaintext: z.string().min(1, "Secret É required."),
  })
  .superRefine((value, context) => {
    if (value.kind === "connector" && !value.keyId)
      context.addIssue({
        code: "custom",
        path: ["keyId"],
        message: "Chave ID É required.",
      });
  });

export type CredentialFormValues = z.infer<typeof credentialFormSchema>;
