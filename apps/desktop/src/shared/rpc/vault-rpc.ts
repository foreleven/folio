import { VaultMiddleware } from './vault-middleware'
import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/unstable/rpc'
import { Vault, VaultError } from '../vault'

/** The main process owns directory selection; renderers never supply arbitrary file operations. */
export const OpenVault = Rpc.make('vault.open', { success: Schema.NullOr(Vault), error: VaultError })
export const OpenExistingVault = Rpc.make('vault.openExisting', {
  payload: { id: Vault.fields.id },
  success: Vault,
  error: VaultError
})
export const GetVault = Rpc.make('vault.get', { payload: {}, success: Schema.NullOr(Vault) }).middleware(VaultMiddleware)
export const RemoveVault = Rpc.make('vault.remove', {
  payload: { id: Vault.fields.id },
  success: Vault,
  error: VaultError
})
export class VaultRpcs extends RpcGroup.make(OpenVault, OpenExistingVault, GetVault, RemoveVault) {}
