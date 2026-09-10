#!/usr/bin/env node
/**
 * PROTOTYPE QUESTION: with Agent, Skills, Integration and raws removed, do the surrounding
 * boundaries safely carry a manually edited wiki file through terminal Run -> Folio source
 * commit -> isolated canonical preparation -> main publication -> normal Task alignment?
 * The scratch repository is deleted on exit. This shell is throwaway; only its findings survive.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { boundaryState } from './manual-wiki-boundary-machine.mjs'

const exec = promisify(execFile)
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))

async function git(cwd, ...args) {
  const result = await exec(
    'git',
    ['-c', 'user.name=Folio Prototype', '-c', 'user.email=prototype@folio.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${devNull}`, ...args],
    {
      cwd,
      env: { ...cleanEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull }
    }
  )
  return result.stdout.trim()
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'folio-wiki-boundary-prototype-'))
  const main = join(root, 'workspace')
  const task = join(root, 'task')
  let runTerminal = false
  let writerStopped = false
  let sourceHead = null
  let acceptedTaskHead = null
  let prepared = null
  let publishedHead = null
  let alignedTaskHead = null
  let edit = 0
  await mkdir(join(main, 'wiki'), { recursive: true })
  await writeFile(join(main, 'wiki/note.md'), 'Baseline\n')
  await git(main, 'init', '--initial-branch=main', '--template=')
  await git(main, 'add', '--', 'wiki/note.md')
  await git(main, 'commit', '-m', 'Baseline')
  await git(main, 'worktree', 'add', '-b', 'folio/task/prototype', task)

  async function facts() {
    return {
      runTerminal,
      writerStopped,
      sourceHead,
      acceptedTaskHead,
      prepared,
      publishedHead,
      alignedTaskHead,
      mainHead: await git(main, 'rev-parse', 'HEAD'),
      taskHead: await git(task, 'rev-parse', 'HEAD'),
      mainDirty: Boolean(await git(main, 'status', '--porcelain', '--untracked-files=all')),
      taskDirty: Boolean(await git(task, 'status', '--porcelain', '--untracked-files=all'))
    }
  }

  async function render(message = '') {
    const current = await facts()
    const gates = boundaryState(current)
    console.clear()
    console.log('\x1b[1mPROTOTYPE — manual wiki boundary\x1b[0m')
    console.log(`\x1b[2mScratch: ${root}\x1b[0m`)
    console.log(`Run terminal:     ${current.runTerminal}`)
    console.log(`Writer stopped:   ${current.writerStopped}`)
    console.log(`Task dirty:       ${current.taskDirty}`)
    console.log(`Task HEAD:        ${current.taskHead.slice(0, 8)}`)
    console.log(`Frozen source:    ${current.sourceHead?.slice(0, 8) ?? '-'}`)
    console.log(`Main dirty:       ${current.mainDirty}`)
    console.log(`Main HEAD:        ${current.mainHead.slice(0, 8)}`)
    console.log(`Canonical:        ${prepared ? (prepared.conflicted ? 'conflict' : prepared.head.slice(0, 8)) : '-'}`)
    console.log(`Published:        ${publishedHead?.slice(0, 8) ?? '-'}`)
    console.log(`Trees converge:   ${(await git(main, 'rev-parse', 'HEAD^{tree}')) === (await git(task, 'rev-parse', 'HEAD^{tree}'))}`)
    console.log('\n\x1b[1mGates\x1b[0m')
    for (const [name, reason] of Object.entries(gates)) console.log(`${name.padEnd(9)} ${reason ?? 'READY'}`)
    if (message) console.log(`\n${message}`)
    console.log('\n[e] edit Task wiki  [r] Run terminal  [w] writer stopped  [c] capture source')
    console.log('[m] edit main wiki  [s] save main  [p] prepare  [v] resolve conflict')
    console.log('[u] publish  [d] newer Task draft  [a] align Task  [q] quit')
  }

  async function action(key) {
    const current = await facts()
    const gates = boundaryState(current)
    if (key === 'e' || key === 'd') {
      edit += 1
      await writeFile(join(task, key === 'e' ? 'wiki/note.md' : `wiki/draft-${edit}.md`), `Task manual edit ${edit}\n`)
      return 'Manually wrote Task disk content.'
    }
    if (key === 'r') {
      runTerminal = true
      return 'Foreground Run marked terminal.'
    }
    if (key === 'w') {
      writerStopped = true
      return 'External writer-stop proof supplied.'
    }
    if (key === 'c') {
      if (gates.capture) return `BLOCKED: ${gates.capture}`
      await git(task, 'add', '--', 'wiki')
      await git(task, 'commit', '-m', 'Save Task wiki\n\nFolio-Change-Kind: wiki')
      sourceHead = acceptedTaskHead = await git(task, 'rev-parse', 'HEAD')
      return 'Folio source commit created and source interval frozen.'
    }
    if (key === 'm') {
      await writeFile(join(main, 'wiki/note.md'), `User main edit ${++edit}\n`)
      return 'Manually wrote unsaved main content.'
    }
    if (key === 's') {
      await git(main, 'add', '--', 'wiki')
      await git(main, 'commit', '-m', 'Save main wiki')
      return 'Main disk content saved as a commit.'
    }
    if (key === 'p') {
      if (gates.prepare) return `BLOCKED: ${gates.prepare}`
      if (prepared) return 'Canonical input already prepared; restart to test a different ordering.'
      const base = await git(main, 'rev-parse', 'HEAD')
      const cwd = join(root, 'coordinator')
      await git(main, 'worktree', 'add', '--detach', cwd, base)
      try {
        await git(cwd, 'cherry-pick', sourceHead)
        prepared = { cwd, base, head: await git(cwd, 'rev-parse', 'HEAD'), conflicted: false }
        return 'Canonical result prepared outside main.'
      } catch {
        prepared = { cwd, base, head: null, conflicted: true }
        return 'Conflict is isolated in the coordinator; main is untouched.'
      }
    }
    if (key === 'v') {
      if (!prepared?.conflicted) return 'No conflict to resolve.'
      const mainText = await readFile(join(main, 'wiki/note.md'), 'utf8')
      const taskText = await readFile(join(task, 'wiki/note.md'), 'utf8')
      await writeFile(join(prepared.cwd, 'wiki/note.md'), `${mainText.trimEnd()}\n${taskText}`)
      await git(prepared.cwd, 'add', '--', 'wiki/note.md')
      await git(prepared.cwd, 'cherry-pick', '--continue')
      prepared = { ...prepared, head: await git(prepared.cwd, 'rev-parse', 'HEAD'), conflicted: false }
      return 'Conflict resolved once in the coordinator.'
    }
    if (key === 'u') {
      if (gates.publish) return `BLOCKED: ${gates.publish}`
      if (publishedHead === prepared.head && current.mainHead === publishedHead) return 'Canonical result was already published.'
      await git(main, 'merge', '--ff-only', prepared.head)
      publishedHead = prepared.head
      return 'Canonical result fast-forwarded to main.'
    }
    if (key === 'a') {
      if (gates.align) return `BLOCKED: ${gates.align}`
      if (alignedTaskHead && current.taskHead === alignedTaskHead) return 'Task was already aligned.'
      const targetTree = await git(main, 'rev-parse', `${publishedHead}^{tree}`)
      const taskTree = await git(task, 'rev-parse', 'HEAD^{tree}')
      if (targetTree !== taskTree) {
        const reconciliation = await git(task, 'commit-tree', targetTree, '-p', acceptedTaskHead, '-m', `Canonical reconciliation\n\nFolio-Canonical-Commit: ${publishedHead}`)
        await git(task, 'cherry-pick', '--ff', reconciliation)
      }
      alignedTaskHead = await git(task, 'rev-parse', 'HEAD')
      return 'Task aligned with a normal child commit; original history remains reachable.'
    }
    return 'Unknown action.'
  }

  /**
   * Accept both an interactive PTY and a newline-delimited scripted run.  The latter keeps the
   * boundary experiment reproducible in CI; readline's async iterator can otherwise miss an EOF
   * that arrives before the first prompt is rendered and leave Node with an unsettled top-level
   * await.  Scripted input still executes the exact same actions and gates as the manual path.
   */
  const handle = async (key) => {
    if (!key) return true
    if (key === 'q') return false
    try {
      await render(await action(key))
    } catch (error) {
      await render(`ERROR: ${error.message}`)
    }
    return true
  }
  const scriptedInput = process.stdin.isTTY ? null : new Promise((resolve, reject) => {
    const chunks = []
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => chunks.push(chunk))
    process.stdin.once('end', () => resolve(chunks.join('')))
    process.stdin.once('error', reject)
  })
  try {
    await render()
    if (process.stdin.isTTY) {
      const input = createInterface({ input: process.stdin, output: process.stdout })
      try {
        for await (const line of input) {
          if (!(await handle(line.trim()[0]))) break
        }
      } finally {
        input.close()
      }
    } else {
      const scripted = await scriptedInput
      for (const line of scripted.split(/\r?\n/)) {
        if (!(await handle(line.trim()[0]))) break
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
