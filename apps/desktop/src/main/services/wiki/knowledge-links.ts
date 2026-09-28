/** Extract Folio Page links from authored Markdown, excluding fenced and inline code. */
export function pageLinkTargets(body: string): readonly string[] {
  const targets = new Set<string>()
  let fence: { marker: string; length: number } | null = null
  for (const line of body.split(/\r?\n/)) {
    const boundary = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (boundary) {
      const marker = boundary[1]![0]!
      if (!fence) fence = { marker, length: boundary[1]!.length }
      else if (fence.marker === marker && boundary[1]!.length >= fence.length) fence = null
      continue
    }
    if (fence || /^(?: {4}|\t)/.test(line)) continue
    const visible = line.replace(/(?<!\\)(`+)(?:.*?)(?<!\\)\1/g, '')
    for (const match of visible.matchAll(/(?<!!)(?<!\\)\[[^\]\n]*\]\(<?folio-page:([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)) {
      targets.add(match[1]!)
    }
  }
  return [...targets]
}

/** Raw citations use a separate URI space and never become Page graph edges. */
export function rawCitationTargets(body: string): readonly string[] {
  const targets = new Set<string>()
  let fence: { marker: string; length: number } | null = null
  for (const line of body.split(/\r?\n/)) {
    const boundary = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (boundary) {
      const marker = boundary[1]![0]!
      if (!fence) fence = { marker, length: boundary[1]!.length }
      else if (fence.marker === marker && boundary[1]!.length >= fence.length) fence = null
      continue
    }
    if (fence || /^(?: {4}|\t)/.test(line)) continue
    const visible = line.replace(/(?<!\\)(`+)(?:.*?)(?<!\\)\1/g, '')
    for (const match of visible.matchAll(/(?<!!)(?<!\\)\[[^\]\n]*\]\(<?(folio-raw:[^\s)>]+)>?(?:\s+"[^"]*")?\)/g))
      targets.add(match[1]!)
  }
  return [...targets]
}
