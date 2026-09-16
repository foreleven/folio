import { useWindowHash } from './hooks/use-window-hash'
import { VaultWorkspace } from './vault/VaultWorkspace'
import { Welcome } from './welcome/Welcome'

/** Shows welcome until this native window is bound to a vault. */
export function App(): React.JSX.Element {
  const hash = useWindowHash()
  if (hash.startsWith('#vault/')) return <VaultWorkspace />
  return <Welcome />
}
