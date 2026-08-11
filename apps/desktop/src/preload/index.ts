import { contextBridge } from 'electron'

const desktopApi = Object.freeze({
  platform: process.platform
})

// Keep the renderer isolated from Node.js; only deliberately reviewed values
// should cross this boundary as the desktop API grows.
contextBridge.exposeInMainWorld('desktop', desktopApi)

