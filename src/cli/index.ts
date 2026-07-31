#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { watch } from 'chokidar'
import { createJiti } from 'jiti'

import { analyze, clearAnalysisCache } from '../analysis/analyzer.js'
import type { ArcherConfig } from '../config/index.js'
import { ArchitectureSuite } from '../engine/suite.js'
import {
  applyBaseline,
  createBaseline,
  readBaseline,
  writeBaseline,
} from '../reporting/baseline.js'
import { report, type ReporterName } from '../reporting/reporters.js'

interface CliOptions {
  readonly baseline?: string
  readonly command: 'check' | 'help' | 'init' | 'version'
  readonly config?: string
  readonly failOnWarnings: boolean
  readonly output?: string
  readonly reporter?: ReporterName
  readonly updateBaseline: boolean
  readonly watch: boolean
}

const CONFIG_NAMES = [
  'archer.config.ts',
  'archer.config.mts',
  'archer.config.cts',
  'archer.config.js',
  'archer.config.mjs',
  'archer.config.cjs',
] as const
const REPORTERS = new Set<ReporterName>([
  'agent',
  'dot',
  'github',
  'json',
  'llm',
  'pretty',
  'sarif',
])

function valueAfter(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('-')) {
    throw new TypeError(`${option} needs a value.`)
  }
  return value
}

function parseArgs(args: readonly string[]): CliOptions {
  let command: CliOptions['command'] = 'check'
  let config: string | undefined
  let reporter: ReporterName | undefined
  let output: string | undefined
  let baseline: string | undefined
  let watchMode = false
  let updateBaseline = false
  let failOnWarnings = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === undefined) continue
    if (argument === 'check' || argument === 'init') command = argument
    else if (argument === 'help' || argument === '--help' || argument === '-h') command = 'help'
    else if (argument === 'version' || argument === '--version' || argument === '-v')
      command = 'version'
    else if (argument === '--watch' || argument === '-w') watchMode = true
    else if (argument === '--update-baseline') updateBaseline = true
    else if (argument === '--fail-on-warnings') failOnWarnings = true
    else if (argument === '--config' || argument === '-c')
      config = valueAfter(args, index++, argument)
    else if (argument === '--output' || argument === '-o')
      output = valueAfter(args, index++, argument)
    else if (argument === '--baseline') baseline = valueAfter(args, index++, argument)
    else if (argument === '--reporter' || argument === '-r') {
      const value = valueAfter(args, index++, argument)
      if (!REPORTERS.has(value as ReporterName)) {
        throw new TypeError(`Unknown reporter '${value}'.`)
      }
      reporter = value as ReporterName
    } else {
      throw new TypeError(`Unknown argument '${argument}'.`)
    }
  }
  return {
    ...(baseline === undefined ? {} : { baseline }),
    command,
    ...(config === undefined ? {} : { config }),
    failOnWarnings,
    ...(output === undefined ? {} : { output }),
    ...(reporter === undefined ? {} : { reporter }),
    updateBaseline,
    watch: watchMode,
  }
}

function currentExitCode(): number {
  return typeof process.exitCode === 'number' ? process.exitCode : 0
}

function findConfig(cwd: string, explicit?: string): string {
  if (explicit !== undefined) {
    const resolved = path.resolve(cwd, explicit)
    if (!existsSync(resolved)) throw new Error(`Archer config not found: ${resolved}`)
    return resolved
  }
  for (const name of CONFIG_NAMES) {
    const candidate = path.join(cwd, name)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`No Archer config found in ${cwd}. Run 'archer init' to create one.`)
}

async function loadConfig(fileName: string): Promise<ArcherConfig> {
  const jiti = createJiti(import.meta.url, { moduleCache: false })
  const config = await jiti.import<unknown>(fileName, { default: true })
  if (
    typeof config !== 'object' ||
    config === null ||
    !('rules' in config) ||
    typeof config.rules !== 'function'
  ) {
    throw new TypeError(`Archer config '${fileName}' must export defineConfig({ rules() {} }).`)
  }
  return config as ArcherConfig
}

async function writeOutput(fileName: string | undefined, content: string): Promise<void> {
  if (fileName === undefined) {
    process.stdout.write(`${content}\n`)
    return
  }
  await mkdir(path.dirname(fileName), { recursive: true })
  await writeFile(fileName, `${content}\n`, 'utf8')
}

async function executeCheck(options: CliOptions, cwd: string): Promise<number> {
  const configPath = findConfig(cwd, options.config)
  const config = await loadConfig(configPath)
  if (config.reporter !== undefined && !REPORTERS.has(config.reporter)) {
    throw new TypeError(`Unknown reporter '${config.reporter}' in ${configPath}.`)
  }
  const configDirectory = path.dirname(configPath)
  const root = path.resolve(configDirectory, config.root ?? '.')
  const suite = new ArchitectureSuite({ ...config, root })
  await config.rules(suite)
  const graph = await analyze({ ...config, root })
  const originalResult = await suite.check(graph)
  const configuredBaseline = options.baseline ?? config.baseline
  const baselinePath = path.resolve(configDirectory, configuredBaseline ?? '.archer-baseline.json')
  if (options.updateBaseline) {
    await writeBaseline(baselinePath, createBaseline(originalResult))
  }
  if (!options.updateBaseline && configuredBaseline !== undefined && !existsSync(baselinePath)) {
    throw new Error(`Archer baseline not found: ${baselinePath}`)
  }
  const result =
    !options.updateBaseline && existsSync(baselinePath)
      ? applyBaseline(originalResult, await readBaseline(baselinePath))
      : originalResult
  const reporter = options.reporter ?? config.reporter ?? 'pretty'
  const output = options.output ?? config.output
  await writeOutput(
    output === undefined ? undefined : path.resolve(configDirectory, output),
    report(reporter, result, graph),
  )
  if (options.updateBaseline) {
    process.stdout.write(`Updated Archer baseline at ${baselinePath}.\n`)
    return 0
  }
  return result.ok && (!options.failOnWarnings || result.warnings === 0) ? 0 : 1
}

async function runWatch(options: CliOptions, cwd: string): Promise<number> {
  const configPath = findConfig(cwd, options.config)
  let running = false
  let pending = false
  async function run(): Promise<void> {
    if (running) {
      pending = true
      return
    }
    running = true
    clearAnalysisCache()
    try {
      const code = await executeCheck(options, cwd)
      process.exitCode = code
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      )
      process.exitCode = 2
    } finally {
      running = false
      if (pending) {
        pending = false
        await run()
      }
    }
  }
  await run()
  const config = await loadConfig(configPath)
  const root = path.resolve(path.dirname(configPath), config.root ?? '.')
  const ignoredFiles = new Set([
    path.resolve(
      path.dirname(configPath),
      options.baseline ?? config.baseline ?? '.archer-baseline.json',
    ),
    ...((options.output ?? config.output) === undefined
      ? []
      : [path.resolve(path.dirname(configPath), options.output ?? config.output ?? '')]),
  ])
  const watcher = watch(root, {
    awaitWriteFinish: { pollInterval: 50, stabilityThreshold: 150 },
    ignored: [
      (fileName) =>
        ignoredFiles.has(path.resolve(fileName)) ||
        /(?:^|[/\\])(?:\.git|node_modules|dist|build|coverage)(?:[/\\]|$)/u.test(fileName),
    ],
    ignoreInitial: true,
  })
  watcher.on('all', () => {
    void run()
  })
  process.stdout.write(`Archer is watching ${root}.\n`)
  return new Promise((resolve) => {
    process.once('SIGINT', () => {
      void watcher.close().then(() => resolve(currentExitCode()))
    })
    process.once('SIGTERM', () => {
      void watcher.close().then(() => resolve(currentExitCode()))
    })
  })
}

async function init(cwd: string): Promise<number> {
  const fileName = path.join(cwd, 'archer.config.ts')
  if (existsSync(fileName)) {
    throw new Error(`Refusing to overwrite ${fileName}.`)
  }
  const template = `import { defineConfig } from '@usescherie/archer'\n\nexport default defineConfig({\n  rules(archer) {\n    archer.expect('src/**').toBeFreeOfCycles()\n  },\n})\n`
  await writeFile(fileName, template, 'utf8')
  process.stdout.write(`Created ${fileName}.\n`)
  return 0
}

const HELP = `Archer - architecture tests for TypeScript and JavaScript\n\nUsage:\n  archer check [options]\n  archer init\n\nOptions:\n  -c, --config <file>       Config file\n  -r, --reporter <name>    pretty, agent, llm, json, sarif, github, or dot\n  -o, --output <file>      Write the report to a file\n      --baseline <file>    Suppress violations in a baseline\n      --update-baseline    Replace the baseline with current violations\n      --fail-on-warnings   Return a failure for warning-level violations\n  -w, --watch              Re-check when project files change\n  -h, --help               Show help\n  -v, --version            Show version`

export async function runCli(args = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  const options = parseArgs(args)
  if (options.command === 'help') {
    process.stdout.write(`${HELP}\n`)
    return 0
  }
  if (options.command === 'version') {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      version: string
    }
    process.stdout.write(`${packageJson.version}\n`)
    return 0
  }
  if (options.command === 'init') return init(cwd)
  return options.watch ? runWatch(options, cwd) : executeCheck(options, cwd)
}

function isDirectEntry(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return path.resolve(entry) === fileURLToPath(import.meta.url)
  }
}

const directEntry = isDirectEntry()
if (directEntry) {
  runCli()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      )
      process.exitCode = 2
    })
}
