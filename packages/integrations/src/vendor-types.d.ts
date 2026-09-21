declare module 'html-to-text' {
  export function convert(html: string, options?: { wordwrap?: false | number }): string
}

declare module 'mailparser' {
  interface AddressValue { text: string }
  interface ParsedMail {
    subject?: string
    from?: AddressValue
    to?: AddressValue | AddressValue[]
    messageId?: string
    text?: string
    html?: string | false
  }
  export function simpleParser(source: Uint8Array, options?: Record<string, unknown>): Promise<ParsedMail>
}
