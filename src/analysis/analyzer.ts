import { stat } from 'node:fs/promises'
import path from 'node:path'

import { glob } from 'tinyglobby'

import type { ArchitectureGraph, ArcherOptions } from '../core/types.js'
import { createDependencyResolver, discoverProjects, projectForFile } from './projects.js'
import { analyzeSource } from './source.js'

const DEFAULT_INCLUDE = [
  'src/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}',
  'apps/*/src/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}',
  'packages/*/src/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}',
] as const
const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
] as const

const graphCache = new Map<string, Promise<ArchitectureGraph>>()

function stableOptions(options: ArcherOptions, root: string): string {
  return JSON.stringify({
    cache: options.cache,
    exclude: options.exclude,
    followSymlinks: options.followSymlinks,
    include: options.include,
    includeTypeDeclarations: options.includeTypeDeclarations,
    projects: options.projects,
    root,
    tsconfig: options.tsconfig,
    workspaces: options.workspaces,
  })
}

async function cacheKey(
  files: readonly string[],
  options: ArcherOptions,
  root: string,
): Promise<string> {
  const configurationFiles = await glob(
    ['**/tsconfig*.json', '**/package.json', 'pnpm-workspace.yaml'],
    {
      absolute: true,
      cwd: root,
      ignore: DEFAULT_EXCLUDE,
      onlyFiles: true,
    },
  )
  const signatures = await Promise.all(
    [...new Set([...files, ...configurationFiles])].toSorted().map(async (file) => {
      const details = await stat(file)
      return `${file}:${details.size}:${details.mtimeMs}`
    }),
  )
  return `${stableOptions(options, root)}\n${signatures.join('\n')}`
}

async function discoverFiles(root: string, options: ArcherOptions): Promise<readonly string[]> {
  const ignore = [
    ...DEFAULT_EXCLUDE,
    ...(options.includeTypeDeclarations === true ? [] : ['**/*.d.ts']),
    ...(options.exclude ?? []),
  ]
  const overrides = (options.projects ?? []).flatMap((project) =>
    typeof project === 'string' || project.include === undefined ? [] : [project],
  )
  const overridePatterns: string[] = []
  const overrideRoots: string[] = []
  const resolvedOverrides = await Promise.all(
    overrides.map(async (project) => {
      const configPaths = await glob(project.tsconfig, {
        absolute: true,
        cwd: root,
        onlyFiles: true,
      })
      return {
        includes: project.include ?? [],
        paths: configPaths.length > 0 ? configPaths : [path.resolve(root, project.tsconfig)],
      }
    }),
  )
  for (const { includes, paths } of resolvedOverrides) {
    for (const configPath of paths) {
      const projectRoot = path.dirname(configPath)
      const relativeRoot = path.relative(root, projectRoot).replaceAll('\\', '/')
      overrideRoots.push(relativeRoot === '' ? '**' : `${relativeRoot}/**`)
      overridePatterns.push(
        ...includes.map((pattern) =>
          relativeRoot === '' ? pattern : `${relativeRoot}/${pattern}`,
        ),
      )
    }
  }
  const files = await glob(options.include ?? DEFAULT_INCLUDE, {
    absolute: true,
    cwd: root,
    dot: true,
    followSymbolicLinks: options.followSymlinks !== false,
    ignore: [...ignore, ...overrideRoots],
    onlyFiles: true,
  })
  if (overridePatterns.length === 0) {
    return files
  }
  const projectFiles = await glob(overridePatterns, {
    absolute: true,
    cwd: root,
    dot: true,
    followSymbolicLinks: options.followSymlinks !== false,
    ignore,
    onlyFiles: true,
  })
  return [...new Set([...files, ...projectFiles])]
}

async function buildGraph(
  files: readonly string[],
  root: string,
  options: ArcherOptions,
): Promise<ArchitectureGraph> {
  const projects = await discoverProjects(root, options)
  const resolve = await createDependencyResolver(root, options)
  const modules = await Promise.all(
    files.toSorted().map((file) => {
      const absolutePath = path.resolve(file)
      const project = projectForFile(absolutePath, projects)
      const sourceFile = project.program.getSourceFile(absolutePath)
      return analyzeSource(absolutePath, root, {
        checker: project.program.getTypeChecker(),
        project: project.info.name,
        resolve: (reference, resolvedSourceFile) =>
          resolve(reference, absolutePath, resolvedSourceFile, project),
        ...(sourceFile === undefined ? {} : { sourceFile }),
      })
    }),
  )

  return {
    dependencies: modules.flatMap((sourceModule) => sourceModule.dependencies),
    modules,
    projects: projects.map((project) => project.info),
    root,
  }
}

export function clearAnalysisCache(): void {
  graphCache.clear()
}

export async function analyze(options: ArcherOptions = {}): Promise<ArchitectureGraph> {
  const root = path.resolve(options.root ?? process.cwd())
  const files = await discoverFiles(root, options)
  if (options.cache === false) {
    return buildGraph(files, root, options)
  }
  const key = await cacheKey(files, options, root)
  const cached = graphCache.get(key)
  if (cached !== undefined) {
    return cached
  }
  const graph = buildGraph(files, root, options)
  if (graphCache.size >= 10) graphCache.clear()
  graphCache.set(key, graph)
  try {
    return await graph
  } catch (error) {
    graphCache.delete(key)
    throw error
  }
}
