import { createHash } from 'node:crypto'

/** Builds exact commit bytes so a persisted operation can recreate the same object after restart. */
export function gitCommitData(input: { readonly tree: string; readonly parent: string; readonly createdAt: number; readonly message: string }): string {
  const identity = `Folio <folio@localhost> ${Math.floor(input.createdAt / 1000)} +0000`
  return `tree ${input.tree}\nparent ${input.parent}\nauthor ${identity}\ncommitter ${identity}\n\n${input.message}`
}

/** Hashes the complete Git object envelope, not only its commit payload. */
export function gitCommitHash(data: string, format: 'sha1' | 'sha256'): string {
  return createHash(format)
    .update(`commit ${Buffer.byteLength(data)}\0`)
    .update(data)
    .digest('hex')
}
