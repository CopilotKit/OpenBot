import { appAccessMethods } from "./plugin-store/app-access";
import { callMethods } from "./plugin-store/calls";
import { connectionMethods } from "./plugin-store/connections";
import { createStoreContext } from "./plugin-store/context";
import { grantMethods } from "./plugin-store/grants";
import type { PluginStoreOptions } from "./plugin-store/model";
import { serverMethods } from "./plugin-store/servers";
import { skillMethods } from "./plugin-store/skills";

export type { CatalogueEntry } from "./catalogue";
export type {
  AccessToken,
  BrokeredDisconnectReason,
  BrokeredProbe,
  ConnectionFootprint,
  GrantedPlugins,
  OAuthClient,
  PendingAuthorization,
  PluginDecision,
  PluginKind,
  PluginStoreOptions,
  ServerAddress,
  ServerRecord,
  SkillActor,
  SkillRecord,
  ToolRecord,
  WithdrawnGrant,
} from "./plugin-store/model";
export {
  BROKERED_PROBE_OUTCOMES,
  CatalogueEntryUnknownError,
  CustomServerRefusedError,
  connectionSiblings,
  deploymentFaultSentence,
  exchangeRefreshTokenOverHttp,
  INVALID_CLIENT,
  isDeploymentFault,
  PluginInvariantError,
  PluginRefusedError,
  refFromToolName,
  TokenRefusedError,
  toolNameFor,
  unlistedAdvertisedTools,
} from "./plugin-store/model";

export function createPluginStore(options: PluginStoreOptions) {
  const context = createStoreContext(options);
  // In the order the methods were always declared. Each group's methods call each other through
  // `this`, which is the whole store when a method is called on it.
  return {
    ...serverMethods(context),
    ...skillMethods(context),
    ...grantMethods(context),
    ...connectionMethods(context),
    ...callMethods(context),
    ...appAccessMethods(context),
  };
}

export type PluginStore = ReturnType<typeof createPluginStore>;
