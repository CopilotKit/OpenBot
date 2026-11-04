import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  CredentialRefusedError,
  type CredentialSecretReader,
  type CredentialStore,
  CredentialUnusableError,
} from "../credentials";
import type { Database } from "../db/client";
import { responsibilitySourceBindings } from "../db/schema/responsibilities";
import {
  ResponsibilityNotFoundError,
  ResponsibilityRefusedError,
} from "./types";

export function createResponsibilityBindingStore(
  database: Database,
  vault: {
    store: CredentialStore;
    reader: CredentialSecretReader;
  },
) {
  const safeColumns = {
    id: responsibilitySourceBindings.id,
    source: responsibilitySourceBindings.source,
    repository: responsibilitySourceBindings.repository,
    createdAt: responsibilitySourceBindings.createdAt,
  };
  return {
    list: (ownerUserId: string) =>
      database
        .select(safeColumns)
        .from(responsibilitySourceBindings)
        .where(eq(responsibilitySourceBindings.ownerUserId, ownerUserId)),
    async create(
      ownerUserId: string,
      input: { repository: string; secret: string },
    ) {
      const repository = input.repository.trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || repository.length > 256)
        throw new ResponsibilityRefusedError(
          "Use the GitHub repository owner/name.",
        );
      if (!input.secret.trim() || input.secret.length > 4096)
        throw new ResponsibilityRefusedError(
          "Supply a webhook secret of 1–4096 characters.",
        );
      const id = randomUUID();
      // The secret goes to the vault first, then the binding that names it; a binding that could not
      // be written takes its secret back with it, so no live secret is left that nothing names.
      const credential = await vault.store.create({
        kind: "connector",
        provider: "github-webhook",
        keyId: id,
        metadata: { ownerUserId },
        plaintext: input.secret,
      });
      try {
        const [binding] = await database
          .insert(responsibilitySourceBindings)
          .values({
            id,
            ownerUserId,
            source: "github",
            repository,
            credentialId: credential.id,
          })
          .returning(safeColumns);
        if (!binding)
          throw new Error("GitHub event binding creation returned no row.");
        return { ...binding, webhookPath: `/api/events/github/${id}` };
      } catch (error) {
        await vault.store.revoke(credential.id).catch(() => undefined);
        throw error;
      }
    },
    async remove(ownerUserId: string, id: string) {
      const [binding] = await database
        .select()
        .from(responsibilitySourceBindings)
        .where(
          and(
            eq(responsibilitySourceBindings.id, id),
            eq(responsibilitySourceBindings.ownerUserId, ownerUserId),
          ),
        );
      if (!binding) throw new ResponsibilityNotFoundError();
      // Revoked before the row goes, so a failure between the two leaves a binding naming a revoked
      // secret (which accepts nothing, and a retry removes) rather than a live secret nothing names.
      try {
        await vault.store.revoke(binding.credentialId);
      } catch (error) {
        if (!(error instanceof CredentialRefusedError)) throw error;
      }
      await database
        .delete(responsibilitySourceBindings)
        .where(eq(responsibilitySourceBindings.id, id));
    },
    async githubBindingFor(id: string) {
      const [binding] = await database
        .select()
        .from(responsibilitySourceBindings)
        .where(eq(responsibilitySourceBindings.id, id));
      if (!binding) return null;
      let secret: string;
      try {
        ({ value: secret } = await vault.reader.reveal(binding.credentialId, {
          purpose: "webhook_signature_check",
          userId: binding.ownerUserId,
        }));
      } catch (error) {
        if (error instanceof CredentialUnusableError) return null;
        throw error;
      }
      return {
        ownerUserId: binding.ownerUserId,
        repository: binding.repository,
        secret,
      };
    },
  };
}
export type ResponsibilityBindingStore = ReturnType<
  typeof createResponsibilityBindingStore
>;
