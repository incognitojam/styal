import * as PostgresEnvironmentLinkCompletion from "./persistence/PostgresEnvironmentLinkCompletion.ts";
import * as PostgresManagedTunnelLimits from "./persistence/PostgresManagedTunnelLimits.ts";
import * as PostgresManagedEndpointAllocations from "./persistence/PostgresManagedEndpointAllocations.ts";
import * as PostgresAgentActivityRows from "./persistence/PostgresAgentActivityRows.ts";
import * as PostgresEnvironmentCredentials from "./persistence/PostgresEnvironmentCredentials.ts";
import * as PostgresEnvironmentLinks from "./persistence/PostgresEnvironmentLinks.ts";
import * as PostgresTunnelOperations from "./persistence/PostgresTunnelOperations.ts";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as RelayHttpApi from "./http/Api.ts";
import * as HookForwarder from "./hooks/HookForwarder.ts";
import * as WebCrypto from "./WebCrypto.ts";
import * as PostgresReplay from "./persistence/PostgresReplay.ts";
import * as PostgresEmailSignInCodes from "./persistence/PostgresEmailSignInCodes.ts";
import * as PostgresAuthSessions from "./persistence/PostgresAuthSessions.ts";
import * as PostgresAccounts from "./persistence/PostgresAccounts.ts";
import * as RelayDb from "./db.ts";
import * as AccountAuth from "./auth/AccountAuth.ts";
import * as AccountData from "./auth/AccountData.ts";
import * as Accounts from "./auth/Accounts.ts";
import * as ClerkDirectory from "./auth/ClerkDirectory.ts";
import * as AuthSessions from "./auth/AuthSessions.ts";
import * as EmailSignInCodes from "./auth/EmailSignInCodes.ts";
import * as CloudMintSigner from "./auth/CloudMintSigner.ts";
import * as RelayTokens from "./auth/RelayTokens.ts";
import * as DpopProofs from "./auth/DpopProofs.ts";
import * as MobileRegistrations from "./agentActivity/MobileRegistrations.ts";
import * as AgentActivityPublisher from "./agentActivity/AgentActivityPublisher.ts";
import * as ApnsDeliveries from "./agentActivity/ApnsDeliveries.ts";
import * as ApnsDeliveryQueue from "./agentActivity/ApnsDeliveryQueue.ts";
import * as AgentActivityRows from "./agentActivity/AgentActivityRows.ts";
import * as Devices from "./agentActivity/Devices.ts";
import * as LiveActivities from "./agentActivity/LiveActivities.ts";
import * as DeliveryAttempts from "./agentActivity/DeliveryAttempts.ts";
import * as FcmDeliveries from "./agentActivity/FcmDeliveries.ts";
import * as FcmClient from "./agentActivity/FcmClient.ts";
import * as FcmAssertionSigner from "./agentActivity/FcmAssertionSigner.ts";
import * as EnvironmentConnector from "./environments/EnvironmentConnector.ts";
import * as EnvironmentLinker from "./environments/EnvironmentLinker.ts";
import * as EnvironmentPublishSignatures from "./environments/EnvironmentPublishSignatures.ts";
import * as ManagedEndpointProvider from "./environments/ManagedEndpointProvider.ts";
import * as ManagedEndpointReaper from "./environments/ManagedEndpointReaper.ts";
import * as EnvironmentCredentials from "./environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "./environments/EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "./environments/ManagedEndpointAllocations.ts";
import * as ManagedTunnelLimits from "./environments/ManagedTunnelLimits.ts";
import * as HeldHooks from "./hooks/HeldHooks.ts";
import * as T3ChatAccounts from "./t3chat/T3ChatAccounts.ts";

const layerRelayApi = Layer.mergeAll(
  RelayHttpApi.layerHealthApi,
  RelayHttpApi.layerMetadataApi,
  RelayHttpApi.layerMobileApi,
  RelayHttpApi.layerClientApi,
  RelayHttpApi.layerTokenApi,
  RelayHttpApi.layerAuthApi,
  RelayHttpApi.layerDpopClientApi,
  RelayHttpApi.layerServerApi,
);

export const layerServices = Layer.empty.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      MobileRegistrations.layer,
      AccountData.layer,
      AccountAuth.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            ClerkDirectory.layer,
            AuthSessions.layer.pipe(Layer.provide(PostgresAuthSessions.layer)),
            EmailSignInCodes.layer.pipe(Layer.provide(PostgresEmailSignInCodes.layer)),
          ),
        ),
      ),
    ),
  ),
  Layer.provideMerge(AgentActivityPublisher.layer),
  Layer.provideMerge(EnvironmentConnector.layer),
  Layer.provideMerge(
    EnvironmentLinker.layer.pipe(Layer.provide(PostgresEnvironmentLinkCompletion.layer)),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      EnvironmentPublishSignatures.layer,
      ManagedEndpointReaper.layer,
      HeldHooks.layer,
    ),
  ),
  Layer.provideMerge(ManagedEndpointProvider.layer),
  Layer.provideMerge(PostgresTunnelOperations.layer),
  Layer.provideMerge(DpopProofs.layer.pipe(Layer.provide(PostgresReplay.layer))),
  Layer.provideMerge(ApnsDeliveries.layer),
  Layer.provideMerge(
    FcmDeliveries.layer.pipe(
      Layer.provideMerge(
        FcmClient.layer.pipe(
          Layer.provide(FcmAssertionSigner.layer),
          Layer.provide(Layer.succeed(WebCrypto.WebCrypto, { subtle: globalThis.crypto.subtle })),
        ),
      ),
    ),
  ),
  Layer.provideMerge(ApnsDeliveryQueue.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      AgentActivityRows.layer.pipe(Layer.provide(PostgresAgentActivityRows.layer)),
      Devices.layer,
    ),
  ),
  Layer.provideMerge(
    EnvironmentCredentials.layer.pipe(Layer.provide(PostgresEnvironmentCredentials.layer)),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      EnvironmentLinks.layer.pipe(Layer.provide(PostgresEnvironmentLinks.layer)),
      ManagedEndpointAllocations.layer.pipe(
        Layer.provide(PostgresManagedEndpointAllocations.layer),
      ),
      ManagedTunnelLimits.layer.pipe(Layer.provide(PostgresManagedTunnelLimits.layer)),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(LiveActivities.layer, T3ChatAccounts.layer)),
  Layer.provideMerge(Accounts.layer.pipe(Layer.provide(PostgresAccounts.layer))),
  Layer.provideMerge(DeliveryAttempts.layer),
  Layer.provideMerge(RelayTokens.layer.pipe(Layer.provideMerge(CloudMintSigner.layer))),
  Layer.provideMerge(RelayDb.RelayTransactions.layer),
);

const layerApi = Layer.merge(
  layerRelayApi,
  HookForwarder.layerApi.pipe(Layer.provide(HookForwarder.layer)),
).pipe(
  Layer.provideMerge(RelayHttpApi.layerClientAuth),
  Layer.provideMerge(RelayHttpApi.layerDpopClientAuth),
  Layer.provideMerge(RelayHttpApi.layerEnvironmentAuth),
);

export const makeAppLayer = <A, E, R>(runtime: Layer.Layer<A, E, R>) =>
  layerApi.pipe(HttpRouter.provideRequest(runtime), Layer.provide(runtime));
