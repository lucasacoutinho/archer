import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'

import { glob } from 'tinyglobby'
import ts from 'typescript'

import type { ArcherOptions, ArcherProjectOptions, Dependency, ProjectInfo } from '../core/types.js'
import type { ImportReference } from './source.js'

export interface ProjectContext {
  readonly compilerOptions: ts.CompilerOptions
  readonly configPath: string
  readonly files: ReadonlySet<string>
  readonly info: ProjectInfo
  readonly moduleResolutionCache: ts.ModuleResolutionCache
  readonly program: ts.Program
  readonly root: string
}

interface WorkspacePackage {
  readonly name: string
  readonly root: string
}

function normalize(value: string): string {
  return value.replaceAll('\\', '/')
}

function canonical(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function defaultCompilerOptions(): ts.CompilerOptions {
  return {
    allowJs: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  }
}

function configPathFrom(value: string, root: string): string {
  const resolved = path.resolve(root, value)
  if (path.extname(resolved).toLowerCase() === '.json') {
    return resolved
  }
  return path.join(resolved, 'tsconfig.json')
}

function parseProject(configPath: string): ProjectContext {
  const readResult = ts.readConfigFile(configPath, ts.sys.readFile)
  if (readResult.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(readResult.error.messageText, '\n'))
  }

  const root = path.dirname(configPath)
  const parsed = ts.parseJsonConfigFileContent(
    readResult.config,
    ts.sys,
    root,
    undefined,
    configPath,
  )
  if (parsed.errors.length > 0) {
    const errors = parsed.errors.map((error) =>
      ts.flattenDiagnosticMessageText(error.messageText, '\n'),
    )
    throw new Error(`Could not read ${configPath}:\n${errors.join('\n')}`)
  }

  const compilerOptions = { ...parsed.options, allowJs: true }
  const program = ts.createProgram({
    options: compilerOptions,
    ...(parsed.projectReferences === undefined
      ? {}
      : { projectReferences: parsed.projectReferences }),
    rootNames: parsed.fileNames,
  })
  return {
    compilerOptions,
    configPath,
    files: new Set(parsed.fileNames.map((file) => canonical(path.resolve(file)))),
    info: {
      name: normalize(path.basename(root)),
      root: normalize(root),
      tsconfig: normalize(configPath),
    },
    moduleResolutionCache: ts.createModuleResolutionCache(root, canonical, compilerOptions),
    program,
    root,
  }
}

function fallbackProject(root: string): ProjectContext {
  const compilerOptions = defaultCompilerOptions()
  const configPath = path.join(root, 'tsconfig.json')
  return {
    compilerOptions,
    configPath,
    files: new Set(),
    info: { name: path.basename(root), root: normalize(root), tsconfig: normalize(configPath) },
    moduleResolutionCache: ts.createModuleResolutionCache(root, canonical, compilerOptions),
    program: ts.createProgram({ options: compilerOptions, rootNames: [] }),
    root,
  }
}

function referencedConfigs(project: ProjectContext): readonly string[] {
  return (project.program.getResolvedProjectReferences() ?? []).flatMap((reference) => {
    if (reference === undefined) {
      return []
    }
    return [reference.sourceFile.fileName]
  })
}

function readWorkspacePatterns(root: string): readonly string[] {
  const packagePath = path.join(root, 'package.json')
  const patterns: string[] = []
  if (existsSync(packagePath)) {
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      workspaces?: readonly string[] | { readonly packages?: readonly string[] }
    }
    if (Array.isArray(packageJson.workspaces)) {
      patterns.push(...packageJson.workspaces)
    } else {
      patterns.push(
        ...((packageJson.workspaces as { readonly packages?: readonly string[] } | undefined)
          ?.packages ?? []),
      )
    }
  }
  const pnpmWorkspace = path.join(root, 'pnpm-workspace.yaml')
  if (existsSync(pnpmWorkspace)) {
    const yaml = readFileSync(pnpmWorkspace, 'utf8')
    const packageBlock = yaml.match(/^packages:\s*\n((?:^[ \t]+-.*\n?)*)/mu)?.[1] ?? ''
    for (const match of packageBlock.matchAll(/^[ \t]+-[ \t]+["']?([^"'\n]+?)["']?[ \t]*$/gmu)) {
      const pattern = match[1]?.trim()
      if (pattern !== undefined) patterns.push(pattern)
    }
  }
  return [...new Set(patterns)]
}

async function workspaceConfigPaths(root: string): Promise<readonly string[]> {
  const patterns = readWorkspacePatterns(root)
  if (patterns.length === 0) {
    return []
  }
  return glob(
    patterns.map((pattern) => `${pattern}/tsconfig.json`),
    {
      absolute: true,
      cwd: root,
      onlyFiles: true,
    },
  )
}

export async function discoverProjects(
  root: string,
  options: ArcherOptions,
): Promise<readonly ProjectContext[]> {
  if (options.tsconfig === false && options.projects === undefined) {
    return [fallbackProject(root)]
  }

  const requested =
    options.projects?.map(
      (project): ArcherProjectOptions =>
        typeof project === 'string' ? { tsconfig: project } : project,
    ) ?? []
  const primaryPath = configPathFrom(
    options.tsconfig === false ? 'tsconfig.json' : (options.tsconfig ?? 'tsconfig.json'),
    root,
  )
  const initialPaths = new Set<string>()
  if (existsSync(primaryPath)) {
    initialPaths.add(primaryPath)
  }
  const requestedMatches = await Promise.all(
    requested.map(async (project) => ({
      matches: await glob(project.tsconfig, { absolute: true, cwd: root, onlyFiles: true }),
      project,
    })),
  )
  for (const { matches, project } of requestedMatches) {
    if (matches.length === 0) {
      initialPaths.add(configPathFrom(project.tsconfig, root))
    } else {
      matches.forEach((match) => initialPaths.add(path.resolve(match)))
    }
  }
  if (options.workspaces !== false) {
    for (const configPath of await workspaceConfigPaths(root)) {
      initialPaths.add(path.resolve(configPath))
    }
  }
  if (initialPaths.size === 0) {
    return [fallbackProject(root)]
  }

  const projects = new Map<string, ProjectContext>()
  const queue = [...initialPaths]
  while (queue.length > 0) {
    const configPath = path.resolve(queue.shift() ?? '')
    if (projects.has(canonical(configPath)) || !existsSync(configPath)) {
      continue
    }
    const project = parseProject(configPath)
    projects.set(canonical(configPath), project)
    for (const reference of referencedConfigs(project)) {
      queue.push(reference)
    }
  }
  return [...projects.values()].toSorted((left, right) => right.root.length - left.root.length)
}

export function projectForFile(
  fileName: string,
  projects: readonly ProjectContext[],
): ProjectContext {
  const resolved = canonical(path.resolve(fileName))
  return (
    projects.find((project) => project.files.has(resolved)) ??
    projects.find((project) => {
      const relative = path.relative(project.root, fileName)
      return (
        relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      )
    }) ??
    projects[0] ??
    fallbackProject(path.dirname(fileName))
  )
}

async function discoverWorkspacePackages(root: string): Promise<readonly WorkspacePackage[]> {
  const patterns = readWorkspacePatterns(root)
  const packagePaths =
    patterns.length === 0
      ? []
      : await glob(
          patterns.map((pattern) => `${pattern}/package.json`),
          {
            absolute: true,
            cwd: root,
            onlyFiles: true,
          },
        )
  return packagePaths.flatMap((packagePath) => {
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as { name?: string }
    return packageJson.name === undefined
      ? []
      : [{ name: packageJson.name, root: path.dirname(packagePath) }]
  })
}

function packageNameOf(specifier: string): string {
  if (specifier.startsWith('@')) {
    return specifier.split('/').slice(0, 2).join('/')
  }
  return specifier.split('/')[0] ?? specifier
}

function within(root: string, fileName: string): boolean {
  const relative = path.relative(root, fileName)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function realPath(fileName: string, followSymlinks: boolean): string {
  if (!followSymlinks) {
    return path.resolve(fileName)
  }
  try {
    return realpathSync.native(fileName)
  } catch {
    return path.resolve(fileName)
  }
}

export async function createDependencyResolver(
  root: string,
  options: ArcherOptions,
): Promise<
  (
    reference: ImportReference,
    from: string,
    sourceFile: ts.SourceFile,
    project: ProjectContext,
  ) => Omit<Dependency, 'column' | 'from' | 'kind' | 'line' | 'specifier'>
> {
  const workspaces = await discoverWorkspacePackages(root)
  const followSymlinks = options.followSymlinks !== false
  const builtins = new Set(
    builtinModules.map((name) => (name.startsWith('node:') ? name.slice(5) : name)),
  )

  return (reference, from, sourceFile, project) => {
    if (reference.target !== undefined) {
      return {
        external: true,
        resolution: 'dynamic',
        resolved: false,
        target: reference.target,
      }
    }
    const specifier = reference.specifier
    if (specifier.startsWith('bun:')) {
      return { external: true, resolution: 'bun', resolved: true, target: specifier }
    }
    const withoutNode = specifier.startsWith('node:') ? specifier.slice(5) : specifier
    const builtinRoot = withoutNode.split('/')[0]
    if (specifier.startsWith('node:') || (builtinRoot !== undefined && builtins.has(builtinRoot))) {
      return {
        external: true,
        resolution: 'node',
        resolved: true,
        target: specifier.startsWith('node:') ? specifier : `node:${specifier}`,
      }
    }

    const mode = ts.getModeForUsageLocation(sourceFile, reference.node, project.compilerOptions)
    const resolved = ts.resolveModuleName(
      specifier,
      from,
      project.compilerOptions,
      ts.sys,
      project.moduleResolutionCache,
      undefined,
      mode,
    ).resolvedModule
    if (resolved === undefined) {
      return {
        external: specifier.startsWith('.') === false && path.isAbsolute(specifier) === false,
        resolution: 'unresolved',
        resolved: false,
        target: `unresolved:${specifier}`,
      }
    }

    const resolvedPath = realPath(resolved.resolvedFileName, followSymlinks)
    const workspace = workspaces.find((candidate) => within(candidate.root, resolvedPath))
    if (workspace !== undefined) {
      return {
        external: false,
        packageName: workspace.name,
        resolution: 'local',
        resolved: true,
        target: normalize(path.relative(root, resolvedPath)),
      }
    }
    const rootRelative = normalize(path.relative(root, resolvedPath))
    if (within(root, resolvedPath) && !rootRelative.split('/').includes('node_modules')) {
      return {
        external: false,
        resolution: 'local',
        resolved: true,
        target: rootRelative,
      }
    }
    if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
      return {
        external: true,
        resolution: 'file',
        resolved: true,
        target: `file:${normalize(path.relative(root, resolvedPath))}`,
      }
    }
    const packageName = packageNameOf(specifier)
    return {
      external: true,
      packageName,
      resolution: 'npm',
      resolved: true,
      target: `npm:${specifier}`,
    }
  }
}
