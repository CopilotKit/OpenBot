import type { ExternalLinkAuthorizationStore } from "../external/link-store";
import { mintExternalLinkToken } from "../external/link-token";
import type { FeishuResolvedUser } from "./channel";

export type FeishuIdentityResolverOptions = {
  store: ExternalLinkAuthorizationStore;
  encryptionKey: string;
  appUrl: string | undefined;
};

export function createFeishuIdentityResolver({
  store,
  encryptionKey,
  appUrl,
}: FeishuIdentityResolverOptions) {
  return async ({
    providerTenantId,
    providerUserId,
  }: {
    provider: "feishu";
    providerTenantId: string;
    providerUserId: string;
  }): Promise<FeishuResolvedUser | null> => {
    const link = await store.find("feishu", providerTenantId, providerUserId);
    if (link) {
      const user = await store.resolveActiveUser(link.openbotUserId);
      return user
        ? {
            kind: "linked",
            user: { id: user.id, name: user.name },
            actor: { id: user.id, role: user.role },
          }
        : null;
    }

    const baseUrl = new URL(appUrl ?? "");
    if (baseUrl.protocol !== "https:" && baseUrl.hostname !== "localhost") {
      throw new Error(
        "Feishu link setup requires an absolute OPENBOT_APP_URL.",
      );
    }
    const token = await mintExternalLinkToken(
      {
        provider: "feishu",
        providerTenantId,
        providerUserId,
        providerEmail: null,
      },
      encryptionKey,
    );
    const url = new URL("/link/feishu", baseUrl);
    url.searchParams.set("token", token);
    return { kind: "unlinked", linkUrl: url.toString() };
  };
}
