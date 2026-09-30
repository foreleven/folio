/** Vite embeds Markdown defaults as strings in desktop bundles. */
declare module '*.md?raw' {
  const content: string
  export default content
}
