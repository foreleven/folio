/// <reference types="vite/client" />

interface Window {
  desktop: Readonly<{
    platform: NodeJS.Platform
  }>
}

