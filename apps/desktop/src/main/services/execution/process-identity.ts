import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export interface ProcessIdentity { readonly started: string; readonly group: number }

/** PID alone is not ownership. Unsupported/unreadable identity is deliberately unknown. */
export async function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (process.platform === 'win32') return null
  try {
    const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'pgid=', '-o', 'lstart='], { timeout: 2000, env: { ...process.env, LC_ALL: 'C' } })
    const match = stdout.trim().match(/^(\d+)\s+(.+)$/)
    return match ? { group: Number(match[1]), started: match[2]! } : null
  } catch { return null }
}
