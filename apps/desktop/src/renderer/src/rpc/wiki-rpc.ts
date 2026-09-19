import { AtomRpc } from 'effect/unstable/reactivity'
import { WikiRpcs } from '../../../shared/rpc/wiki-rpc'
import { ElectronRpcProtocolLive } from './electron-rpc-protocol'

export class WikiRpcClient extends AtomRpc.Service<WikiRpcClient>()('folio/renderer/WikiRpcClient', {
  group: WikiRpcs, protocol: ElectronRpcProtocolLive
}) {
  static readonly readPage = WikiRpcClient.mutation('wiki.read')
  static readonly savePage = WikiRpcClient.mutation('wiki.save')
  static readonly saveTypes = WikiRpcClient.mutation('wiki.saveTypes')
}
