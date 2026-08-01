import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const configured = process.env.TIACORE_CLI?.trim()
const candidates = [
  ...(configured === undefined || configured === '' ? [] : [configured]),
  path.resolve('node_modules/@usescherie/tiacore/dist/entries/cli.js'),
  path.resolve('..', 'tiacore', 'dist', 'entries', 'cli.js'),
]
const cli = candidates.find((candidate) => existsSync(candidate))

if (cli === undefined) {
  throw new Error(
    'tiacore is unavailable. Install @usescherie/tiacore, set TIACORE_CLI, or build the adjacent ../tiacore checkout.',
  )
}

const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
})

if (result.error !== undefined) throw result.error
if (result.signal !== null) {
  process.kill(process.pid, result.signal)
} else {
  process.exitCode = result.status ?? 1
}
