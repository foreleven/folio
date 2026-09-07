// This parser-blocking script runs before the body can paint. Electron has already
// resolved the persisted theme, so no async RPC or second preference store is needed.
const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
document.documentElement.classList.toggle('dark', dark)
document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
