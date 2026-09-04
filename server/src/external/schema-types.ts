export const EXTERNAL_PROVIDERS = ["slack", "feishu"] as const;

export type ExternalProvider = (typeof EXTERNAL_PROVIDERS)[number];

export function isExternalProvider(value: unknown): value is ExternalProvider {
  return EXTERNAL_PROVIDERS.some((provider) => provider === value);
}

export type ExternalProviderIdentity = {
  provider: ExternalProvider;
  providerTenantId: string;
  providerUserId: string;
  providerEmail: string | null;
};

export type ExternalUserLink = ExternalProviderIdentity & {
  openbotUserId: string;
  linkedAt: Date;
  updatedAt: Date;
};
