export type ExternalProvider = "slack";

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
