import { Effect } from 'effect'
import { program } from './program'

void Effect.runPromise(program).catch((error: unknown) => {
  console.error('Failed to run main program', error)
})
