import { z } from "zod";

/**
 * Adding an MCP server by its address. The server decides the rest (whether it needs a key, whether
 * the address is safe to reach), so this checks only what a person can fix before pressing Add.
 */
export const addServerFormSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Give it a name.")
    .max(60, "Keep the name under 60 characters."),
  url: z
    .string()
    .trim()
    .min(1, "Enter the server's address.")
    .refine(
      (value) => URL.canParse(value),
      "Enter the full address, starting with https://.",
    )
    .refine(
      (value) =>
        !URL.canParse(value) || /^https?:$/.test(new URL(value).protocol),
      "Enter a web address that starts with https://.",
    ),
  token: z.string(),
});

export type AddServerFormValues = z.infer<typeof addServerFormSchema>;
