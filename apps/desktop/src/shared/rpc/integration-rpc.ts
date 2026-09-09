import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/unstable/rpc'
import { IntegrationSettingsError, IntegrationView } from '../integration'

const Identity = Schema.Struct({ id: Schema.NonEmptyString })
export class IntegrationRpcs extends RpcGroup.make(
  Rpc.make('integrations.watch', { success: Schema.Array(IntegrationView), error: IntegrationSettingsError, stream: true }),
  Rpc.make('integrations.install', { payload: Identity, success: Schema.Void, error: IntegrationSettingsError }),
  Rpc.make('integrations.inspect', { payload: Identity, success: Schema.Void, error: IntegrationSettingsError }),
  Rpc.make('integrations.action', { payload: Schema.Struct({ id: Schema.NonEmptyString, actionId: Schema.NonEmptyString, payload: Schema.optional(Schema.Unknown) }), success: Schema.Void, error: IntegrationSettingsError }),
) {}
