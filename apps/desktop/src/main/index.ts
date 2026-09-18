import { app } from 'electron'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import { program } from './program'

// Runtime files have one application writer. SQLite alone cannot arbitrate file ownership.
if (!app.requestSingleInstanceLock()) app.quit()
else NodeRuntime.runMain(program)
