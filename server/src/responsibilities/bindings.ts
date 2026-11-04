/**
 * A repository a person bound as a responsibility source, with the webhook secret GitHub signs with.
 *
 * The binding is a record in Intelligence's agent schedules (`responsibility-source-bindings`); the
 * secret stays in this deployment's vault and the record names it by `credentialRef`, never holding
 * it. The vault row is written first and retired again if Intelligence refuses the binding, so a
 * refusal never leaves a live secret nobody can reach; deleting a binding retires its secret.
 * An inbound GitHub delivery finds its binding in this instance's schedule directory.
 */
import { randomUUID } from "node:crypto";
import {
  type CredentialSecretReader,
  type CredentialStore,
  decryptSecret,
  encryptSecret,
} from "../credentials";
import type { Database } from "../db/client";
import { schedules } from "../schedules/directory";
import type { ResponsibilitySourceBindingRecord } from "../schedules/types";
import { withLocalLock } from "../work/local-lock";
import {
  ResponsibilityNotFoundError,
  ResponsibilityRefusedError,
} from "./types";

const safe = (binding: ResponsibilitySourceBindingRecord) => ({
  id: binding.id,
  source: binding.source,
  repository: binding.repository,
  createdAt: binding.createdAt,
});

export function createResponsibilityBindingStore(
  database: Database,
  vault: {
    store: CredentialStore;
    reader: CredentialSecretReader;
    encryptionKey: string;
  },
) {
  return {
    async list(ownerUserId: string) {
      const { items } = await schedules().client.all(
        "responsibility-source-bindings",
        { ownerUserId },
      );
      return items.map(safe);
    },
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
      const encryptedValue = await encryptSecret(
        vault.encryptionKey,
        input.secret,
      );
      const credential = await vault.store.create({
        kind: "connector",
        provider: "github-webhook",
        keyId: id,
        metadata: { ownerUserId },
        encryptedValue,
      });
      let binding: ResponsibilitySourceBindingRecord;
      try {
        binding = await schedules().create(
          "responsibility-source-bindings",
          {
            id,
            ownerUserId,
            source: "github",
            repository,
            credentialRef: credential.id,
          },
          `openbot:binding:${id}`,
        );
      } catch (error) {
        // Refused, or not answered: the secret goes again rather than outliving a binding that is not there.
        await vault.store.revoke(credential.id).catch(() => undefined);
        throw error;
      }
      return { ...safe(binding), webhookPath: `/api/events/github/${id}` };
    },
    async remove(ownerUserId: string, id: string) {
      await withLocalLock(
        database,
        `responsibility-binding:${id}`,
        async () => {
          const binding = await schedules().refresh(
            "responsibility-source-bindings",
            id,
          );
          if (
            !binding ||
            binding.deletedAt !== null ||
            binding.ownerUserId !== ownerUserId
          )
            throw new ResponsibilityNotFoundError();
          await schedules().remove("responsibility-source-bindings", id);
          await vault.store.revoke(binding.credentialRef);
        },
      );
    },
    async githubBindingFor(id: string) {
      const binding = await schedules().find(
        "responsibility-source-bindings",
        id,
      );
      if (!binding || binding.deletedAt !== null) return null;
      const credential = await vault.reader.readSecret(binding.credentialRef);
      if (!credential || credential.revokedAt) return null;
      return {
        ownerUserId: binding.ownerUserId,
        repository: binding.repository,
        secret: await decryptSecret(
          vault.encryptionKey,
          credential.encryptedValue,
        ),
      };
    },
  };
}
export type ResponsibilityBindingStore = ReturnType<
  typeof createResponsibilityBindingStore
>;
