import { expect, it } from 'vitest'
import { processIdentity } from './process-identity'

it.skipIf(process.platform === 'win32')('reads process start identity without treating the PID as identity', async () => {
  const current = await processIdentity(process.pid)
  expect(current?.started).toBeTruthy()
  expect(current?.group).toBeGreaterThan(0)
  expect(await processIdentity(process.pid)).toEqual(current)
  expect(await processIdentity(2147483647)).toBeNull()
})
