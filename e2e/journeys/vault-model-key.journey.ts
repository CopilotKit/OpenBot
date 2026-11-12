import type { APIRequestContext } from "@playwright/test";
import { DUMMY_OPENAI_KEY } from "../harness/config";
import { expect, test } from "../harness/test";

/**
 * A PERSON'S MODEL KEY, ADDED FROM THE VAULT, IS THE KEY THE PERSONAL ASSISTANT USES.
 *
 * It used not to be: Add key asked for a free-text provider and key ID, with "OpenAI" and
 * "production" as placeholders, and a key saved that way was never read (#1524). Add key now asks a
 * model key only which provider it is for, starts on the one the Bots run on, says whether they will
 * use it, and files it under the name they read.
 *
 * Setup's AI model row asks the same question the Personal Assistant's every turn asks (the same
 * provider and key name, `server/src/index.ts`), so it is where "is this key used?" is read here,
 * without spending a model call.
 */

type Credential = {
  id: string;
  kind: string;
  provider: string;
  keyId: string;
  revokedAt: string | null;
};

async function credentials(request: APIRequestContext): Promise<Credential[]> {
  const response = await request.get("/api/admin/credentials");
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as
    | Credential[]
    | { credentials: Credential[] };
  return Array.isArray(body) ? body : body.credentials;
}

/** The Personal Assistant's key is live again, whatever this journey got to before it ended. */
async function restore(request: APIRequestContext) {
  const live = (await credentials(request)).some(
    (credential) =>
      credential.revokedAt === null &&
      credential.kind === "model" &&
      credential.provider === "openai" &&
      credential.keyId === "openai-api-key",
  );
  if (live) return;
  const saved = await request.post("/api/admin/credentials", {
    data: {
      kind: "model",
      provider: "openai",
      keyId: "openai-api-key",
      plaintext: DUMMY_OPENAI_KEY,
      metadata: {},
    },
  });
  expect(saved.ok(), "the Personal Assistant's key is put back").toBe(true);
}

test.afterEach(async ({ request }) => {
  await restore(request);
});

test("a person with no model key adds one from Setup, and the Personal Assistant uses it", async ({
  page,
  shot,
}) => {
  const main = page.getByRole("main");
  const aiModel = main
    .getByRole("list", { name: "Setup" })
    .getByRole("listitem")
    .filter({ hasText: "AI model" });
  const provider = main.getByRole("combobox", { name: "Provider" });

  await test.step("without a model key, Setup says OpenBot can't answer", async () => {
    await page.goto("/settings/vault");
    await main
      .locator('[data-slot="item"]')
      .filter({ hasText: "model · openai-api-key · active" })
      .getByRole("button", { name: "Revoke" })
      .click();
    await expect(
      main.getByText("model · openai-api-key · revoked"),
    ).toBeVisible();
    await page.goto("/settings/setup");
    await expect(aiModel).toBeVisible();
    await main.getByRole("button", { name: "Check again" }).click();
    await expect(aiModel).toContainText("Needs setup");
    await expect(aiModel).toContainText(
      "Without a model key, OpenBot can't answer.",
    );
    await shot("no-model-key");
  });

  await test.step("Setup's Vault link opens Add key, on the provider the Bots run on", async () => {
    await aiModel.getByRole("link", { name: "Vault" }).click();
    await expect(
      page.getByRole("heading", { name: "Add key", level: 1 }),
    ).toBeVisible();
    await expect(main.getByRole("combobox", { name: "Type" })).toContainText(
      "Model",
    );
    await expect(provider).toContainText("OpenAI");
    await expect(
      main.getByText("Your Bots run on OpenAI and will use this key."),
    ).toBeVisible();
    // Nothing to name, so nothing to get wrong.
    await expect(main.getByRole("textbox", { name: "Key ID" })).toHaveCount(0);
    await shot("add-model-key");
  });

  await test.step("a key for another provider says the Bots won't use it", async () => {
    await provider.click();
    await page.getByRole("option", { name: "Anthropic" }).click();
    await expect(provider).toContainText("Anthropic");
    await expect(
      main.getByText("Your Bots run on OpenAI, so they won't use this key."),
    ).toBeVisible();
    await shot("other-provider");
    await provider.click();
    await page.getByRole("option", { name: "OpenAI" }).click();
    await expect(
      main.getByText("Your Bots run on OpenAI and will use this key."),
    ).toBeVisible();
  });

  await test.step("paste the key and save: it is filed where the Bots read it", async () => {
    await main.getByRole("textbox", { name: "Secret" }).fill(DUMMY_OPENAI_KEY);
    await main.getByRole("button", { name: "Save credential" }).click();
    await expect(
      page.getByRole("heading", { name: "Vault", level: 1 }),
    ).toBeVisible();
    await expect(
      main.getByText("model · openai-api-key · active"),
    ).toBeVisible();
    await shot("vault-model-key");
  });

  await test.step("OpenBot uses it: Setup no longer says the AI model needs a key", async () => {
    await page.goto("/settings/setup");
    await expect(aiModel).not.toContainText("Needs setup");
    await expect(aiModel).toContainText(
      "The key is set but hasn't been checked.",
    );
    // Pressed until it checks, as a person would: a Check again within 10 s of the last check
    // does nothing (the known failure below).
    await expect(async () => {
      await main.getByRole("button", { name: "Check again" }).click();
      await expect(aiModel).toContainText(
        "The key is set. OpenBot can't check a custom endpoint.",
        { timeout: 2_000 },
      );
    }).toPass({ timeout: 30_000 });
    await shot("setup-key-set");
  });

  await test.step("adding another model key says it replaces the live one", async () => {
    await page.goto("/settings/vault");
    await main.getByRole("button", { name: "Add key" }).click();
    await expect(provider).toContainText("OpenAI");
    await expect(
      main.getByText(
        "This key already has an active credential. Saving replaces it and revokes the old one.",
      ),
    ).toBeVisible();
    await shot("replace-model-key");
    await main.getByRole("button", { name: "Cancel" }).click();
    await expect(
      page.getByRole("heading", { name: "Vault", level: 1 }),
    ).toBeVisible();
  });
});

test("Check again checks a key added a moment ago", async ({ page, shot }) => {
  test.fail(
    true,
    'KNOWN BUG: Check again is limited to one round every 10 s (RECHECK_INTERVAL_MS in server/src/setup/checklist.ts), and opening Setup starts a round. Pressed within 10 s of the last one, it answers from that older round, so a key added a moment ago stays "set but hasn\'t been checked" while the row says to press Check again, and nothing says to wait.',
  );
  const main = page.getByRole("main");
  const aiModel = main
    .getByRole("list", { name: "Setup" })
    .getByRole("listitem")
    .filter({ hasText: "AI model" });

  await page.goto("/settings/vault");
  await main
    .locator('[data-slot="item"]')
    .filter({ hasText: "model · openai-api-key · active" })
    .getByRole("button", { name: "Revoke" })
    .click();
  await expect(
    main.getByText("model · openai-api-key · revoked").first(),
  ).toBeVisible();
  // The person checks, reads that OpenBot needs a key, adds it, and comes straight back.
  await page.goto("/settings/setup");
  await expect(aiModel).toBeVisible();
  await main.getByRole("button", { name: "Check again" }).click();
  await expect(aiModel).toContainText("Needs setup");

  await aiModel.getByRole("link", { name: "Vault" }).click();
  await main.getByRole("textbox", { name: "Secret" }).fill(DUMMY_OPENAI_KEY);
  await main.getByRole("button", { name: "Save credential" }).click();
  await expect(main.getByText("model · openai-api-key · active")).toBeVisible();

  await page.goto("/settings/setup");
  await expect(aiModel).toContainText(
    "The key is set but hasn't been checked.",
  );
  await main.getByRole("button", { name: "Check again" }).click();
  await shot("check-again-right-after");
  await expect(aiModel).toContainText(
    "The key is set. OpenBot can't check a custom endpoint.",
    { timeout: 5_000 },
  );
});
