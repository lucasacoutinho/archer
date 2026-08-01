import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const cli = path.join(root, 'dist', 'cli.js')
const packageVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version

function run(...cliArguments) {
  return spawnSync(process.execPath, [cli, ...cliArguments], {
    cwd: root,
    encoding: 'utf8',
  })
}

test('checks architecture with an explicit or default command', () => {
  const checkArguments = ['--config', 'test/fixtures/cli/archer.config.mjs', '--reporter', 'agent']

  for (const invocation of [['check', ...checkArguments], checkArguments]) {
    const result = run(...invocation)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /^archer: ok files=14 dependencies=19/mu)
  }
})

test('returns one when architecture rules fail', () => {
  const result = run(
    'check',
    '--config',
    'test/fixtures/cli/archer.failing.config.mjs',
    '--reporter',
    'agent',
  )

  assert.equal(result.status, 1)
  assert.match(result.stdout, /^archer: fail/mu)
})

test('returns two for invalid Commander input', () => {
  const result = run('check', '--reporter', 'invalid')

  assert.equal(result.status, 2)
  assert.match(result.stderr, /argument 'invalid' is invalid/u)
})

test('prints Commander help and package version', () => {
  const help = run('check', '--help')
  const version = run('--version')

  assert.equal(help.status, 0)
  assert.match(help.stdout, /Usage: archer check \[options\]/u)
  assert.equal(version.status, 0)
  assert.equal(version.stdout.trim(), packageVersion)
})
