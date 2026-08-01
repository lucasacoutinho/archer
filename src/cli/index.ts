#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { watch } from 'chokidar'
import { Command, CommanderError, InvalidArgumentError } from 'commander'
import { clearAnalysisCache } from '../analysis/analyzer.js'
import { checkArchitecture, type ArchitectureCheckExecution } from '../application/check.js'
import type { ReporterName } from '../reporting/reporters.js'

interface CliOptions {
  readonly baseline?: string
  readonly config?: string
  readonly failOnWarnings: boolean
  readonly output?: string
  readonly reporter?: ReporterName
  readonly updateBaseline: boolean
  readonly watch: boolean
}

type ParsedCliOptions = Partial<CliOptions>

const REPORTERS = new Set<ReporterName>([
  'agent',
  'dot',
  'github',
  'json',
  'llm',
  'pretty',
  'sarif',
])

function parseReporter(value: string): ReporterName {
  if (!REPORTERS.has(value as ReporterName)) {
    throw new InvalidArgumentError(
      `expected one of ${[...REPORTERS].toSorted().join(', ')}; received '${value}'`,
    )
  }
  return value as ReporterName
}

function normalizeOptions(options: ParsedCliOptions): CliOptions {
  return {
    ...(options.baseline === undefined ? {} : { baseline: options.baseline }),
    ...(options.config === undefined ? {} : { config: options.config }),
    failOnWarnings: options.failOnWarnings ?? false,
    ...(options.output === undefined ? {} : { output: options.output }),
    ...(options.reporter === undefined ? {} : { reporter: options.reporter }),
    updateBaseline: options.updateBaseline ?? false,
    watch: options.watch ?? false,
  }
}

function currentExitCode(): number {
  return typeof process.exitCode === 'number' ? process.exitCode : 0
}

async function executeCheck(options: CliOptions, cwd: string): Promise<ArchitectureCheckExecution> {
  const execution = await checkArchitecture({
    ...(options.baseline === undefined ? {} : { baseline: options.baseline }),
    ...(options.config === undefined ? {} : { config: options.config }),
    cwd,
    failOnWarnings: options.failOnWarnings,
    ...(options.output === undefined ? {} : { output: options.output }),
    ...(options.reporter === undefined ? {} : { reporter: options.reporter }),
    updateBaseline: options.updateBaseline,
  })
  if (execution.outputPath === undefined) process.stdout.write(`${execution.content}\n`)
  if (execution.updatedBaseline) {
    process.stdout.write(`Updated Archer baseline at ${execution.baselinePath}.\n`)
  }
  return execution
}

async function runWatch(options: CliOptions, cwd: string): Promise<number> {
  let running = false
  let pending = false
  let lastExecution: ArchitectureCheckExecution | undefined
  async function run(): Promise<void> {
    if (running) {
      pending = true
      return
    }
    running = true
    clearAnalysisCache()
    try {
      lastExecution = await executeCheck(options, cwd)
      process.exitCode = lastExecution.code
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
  const root = lastExecution?.graph.root ?? cwd
  const ignoredFiles = new Set([
    lastExecution?.baselinePath ?? path.resolve(cwd, options.baseline ?? '.archer-baseline.json'),
    ...(lastExecution?.outputPath === undefined ? [] : [lastExecution.outputPath]),
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

function packageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
  return packageJson.version
}

function configureCheck(command: Command, action: (options: CliOptions) => Promise<void>): Command {
  return command
    .exitOverride()
    .option('-c, --config <file>', 'config file')
    .option(
      '-r, --reporter <name>',
      'pretty, agent, llm, json, sarif, github, or dot',
      parseReporter,
    )
    .option('-o, --output <file>', 'write the report to a file')
    .option('--baseline <file>', 'suppress violations in a baseline')
    .option('--update-baseline', 'replace the baseline with current violations')
    .option('--fail-on-warnings', 'return a failure for warning-level violations')
    .option('-w, --watch', 're-check when project files change')
    .action(async () => action(normalizeOptions(command.opts<ParsedCliOptions>())))
}

export async function runCli(args = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  let result = 0
  const runCheck = async (options: CliOptions): Promise<void> => {
    result = options.watch ? await runWatch(options, cwd) : (await executeCheck(options, cwd)).code
  }
  const program = new Command()
    .name('archer')
    .description('Architecture tests for TypeScript and JavaScript')
    .usage('[command] [options]')
    .version(packageVersion(), '-v, --version', 'show version')
    .showHelpAfterError()
    .exitOverride()

  const check = configureCheck(
    new Command('check').description('check architecture rules'),
    runCheck,
  )
  program.addCommand(check, { isDefault: true })
  program
    .command('init')
    .exitOverride()
    .description('create archer.config.ts')
    .action(async () => {
      result = await init(cwd)
    })

  try {
    await program.parseAsync(args, { from: 'user' })
    return result
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2
    throw error
  }
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
