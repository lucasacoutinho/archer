import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { createJiti } from 'jiti'

import { analyze } from '../analysis/analyzer.js'
import type { ArcherConfig } from '../config/index.js'
import type { ArchitectureGraph, ArchitectureResult } from '../core/types.js'
import { ArchitectureSuite } from '../engine/suite.js'
import {
  applyBaseline,
  createBaseline,
  readBaseline,
  writeBaseline,
} from '../reporting/baseline.js'
import { report, type ReporterName } from '../reporting/reporters.js'

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

export interface ArchitectureCheckOptions {
  readonly baseline?: string
  readonly config?: string
  readonly cwd?: string
  readonly failOnWarnings?: boolean
  readonly output?: string
  readonly reporter?: ReporterName
  readonly updateBaseline?: boolean
}

export interface ArchitectureCheckExecution {
  readonly baselinePath: string
  readonly code: 0 | 1
  readonly content: string
  readonly graph: ArchitectureGraph
  readonly outputPath?: string
  readonly result: ArchitectureResult
  readonly updatedBaseline: boolean
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
  const jiti = createJiti(fileName, { moduleCache: false })
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

async function writeReport(fileName: string, content: string): Promise<void> {
  await mkdir(path.dirname(fileName), { recursive: true })
  await writeFile(fileName, `${content}\n`, 'utf8')
}

export async function checkArchitecture(
  options: ArchitectureCheckOptions = {},
): Promise<ArchitectureCheckExecution> {
  const cwd = path.resolve(options.cwd ?? process.cwd())
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
  const updateBaseline = options.updateBaseline ?? false

  if (updateBaseline) await writeBaseline(baselinePath, createBaseline(originalResult))
  if (!updateBaseline && configuredBaseline !== undefined && !existsSync(baselinePath)) {
    throw new Error(`Archer baseline not found: ${baselinePath}`)
  }

  const result =
    !updateBaseline && existsSync(baselinePath)
      ? applyBaseline(originalResult, await readBaseline(baselinePath))
      : originalResult
  const reporter = options.reporter ?? config.reporter ?? 'pretty'
  const content = report(reporter, result, graph)
  const configuredOutput = options.output ?? config.output
  const outputPath =
    configuredOutput === undefined ? undefined : path.resolve(configDirectory, configuredOutput)
  if (outputPath !== undefined) await writeReport(outputPath, content)

  return {
    baselinePath,
    code: result.ok && (!(options.failOnWarnings ?? false) || result.warnings === 0) ? 0 : 1,
    content,
    graph,
    ...(outputPath === undefined ? {} : { outputPath }),
    result,
    updatedBaseline: updateBaseline,
  }
}
