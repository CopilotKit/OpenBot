import { expect, test } from "bun:test";
import { credentialFormSchema } from "@/lib/credentials/form";

test("requires credential type, provider, key ID, and secret", () => {
  expect(
    credentialFormSchema.safeParse({
      kind: "model",
      provider: "",
      keyId: "",
      plaintext: "",
    }).success,
  ).toBeFalse();
});
