import { useSyncExternalStore } from 'react'

/** Follows same-document Electron navigation without requiring a renderer process reload. */
function subscribeToHashChange(notify: () => void): () => void {
  window.addEventListener('hashchange', notify)
  return () => window.removeEventListener('hashchange', notify)
}

/** Returns the current native-window route for React's external-store subscription. */
function getWindowHash(): string {
  return window.location.hash
}

/** Subscribes to this window's route and releases the listener when unmounted. */
export function useWindowHash(): string {
  return useSyncExternalStore(subscribeToHashChange, getWindowHash)
}
