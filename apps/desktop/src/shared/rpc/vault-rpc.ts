import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/unstable/rpc'
import { Vault, VaultError } from '../vault'

/** The main process owns directory selection; renderers never supply arbitrary file operations. */
export const OpenVault = Rpc.make('vault.open', { success: Schema.NullOr(Vault), error: VaultError })
export const GetVault = Rpc.make('vault.get', { payload: { id: Schema.String }, success: Schema.NullOr(Vault) })
export class VaultRpcs extends RpcGroup.make(OpenVault, GetVault) {}
