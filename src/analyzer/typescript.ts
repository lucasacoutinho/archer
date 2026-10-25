/** The TypeScript adapter of the Analyzer. Contract: docs/contracts/analyzer.md. */
import { Effect, Exit, FileSystem, Match, Path, Ref, Scope, Semaphore } from "effect"
import { API, DiagnosticCategory, type Project, type Snapshot } from "typescript/unstable/async"
import type { FilePath, Graph, SourceFile, Target } from "../core/model.ts"
import type { AnalyzerShape, Workspace } from "./workspace.ts"
import { type AnalysisError, AnalyzerUnavailable, ProjectNotFound, ProjectParseFailed } from "./errors.ts"
import { compareCodeUnits, isDeclarationFileName, isJsonFileName, NODE_MODULES, splitPath } from "./paths.ts"
import { type RawDependency, type RawSource, readSource } from "./source.ts"
import { serverExit } from "./server-exit.ts"
import { builtinTarget, fileCandidates, installedPackage, isInstalled, packageTarget, specifierPackage } from "./targets.ts"

const unavailable = (cause: unknown): AnalyzerUnavailable => new AnalyzerUnavailable({ cause })

const attempt = <A>(evaluate: () => A): Effect.Effect<A, AnalyzerUnavailable> => Effect.try({ try: evaluate, catch: unavailable })

const attemptPromise = <A>(evaluate: () => Promise<A>): Effect.Effect<A, AnalyzerUnavailable> =>
  Effect.tryPromise({ try: evaluate, catch: unavailable })

interface Diagnostic {
  readonly fileName?: string | undefined
  readonly code: number
  readonly text: string
}

interface Session {
  readonly remote: Remote
  readonly scope: Scope.Closeable
}

interface Remote {
  readonly api: API
  /** Runs a request, failing with AnalyzerUnavailable when it rejects or the server exits first. */
  readonly request: <A>(evaluate: () => Promise<A>) => Effect.Effect<A, AnalyzerUnavailable>
}

interface Server {
  readonly use: <A, E extends AnalysisError>(
    run: (remote: Remote) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | AnalyzerUnavailable>
}

interface Targets {
  readonly target: (dependency: RawDependency, directory: string) => Effect.Effect<Target, AnalyzerUnavailable>
}

interface Read {
  readonly raw: RawSource
  readonly caseSensitive: boolean
}

/**
 * The server starts on first use and stops with the layer's scope. A failure
 * that makes the server unusable also stops it, so the next call starts a new one.
 */
const makeServer: Effect.Effect<Server, never, Scope.Scope> = Effect.gen(function* () {
  const layerScope = yield* Effect.scope
  const current = yield* Ref.make<Session | undefined>(undefined)
  const lock = yield* Semaphore.make(1)

  const start: Effect.Effect<Session, AnalyzerUnavailable> = Effect.gen(function* () {
    const scope = yield* Scope.fork(layerScope)
    const api = yield* Effect.acquireRelease(
      attempt(() => new API()),
      (started) => attemptPromise(() => started.close()).pipe(Effect.ignore),
    ).pipe(Scope.provide(scope), Effect.tapError(() => Scope.close(scope, Exit.void)))
    yield* attemptPromise(() => api.updateSnapshot().then((snapshot) => snapshot.dispose())).pipe(
      Effect.tapError(() => Scope.close(scope, Exit.void)),
    )
    const exited = serverExit(api)
    const lost = (): Promise<never> =>
      exited.then((): never => {
        throw new Error("TypeScript server exited")
      })
    const request = <A>(evaluate: () => Promise<A>): Effect.Effect<A, AnalyzerUnavailable> =>
      attemptPromise(() => Promise.race([evaluate(), lost()]))
    const remote: Remote = { api, request }
    const session: Session = { remote, scope }
    yield* Ref.set(current, session)
    return session
  })

  const stop: Effect.Effect<void> = Effect.gen(function* () {
    const session = yield* Ref.getAndSet(current, undefined)
    if (session !== undefined) {
      yield* Scope.close(session.scope, Exit.void)
    }
  })

  /** A request cannot be taken back, so an interrupted analysis finishes before the next one starts. */
  const use = <A, E extends AnalysisError>(run: (remote: Remote) => Effect.Effect<A, E>): Effect.Effect<A, E | AnalyzerUnavailable> =>
    lock.withPermit(
      Effect.gen(function* () {
        const session = (yield* Ref.get(current)) ?? (yield* start)
        return yield* run(session.remote)
      }).pipe(
        Effect.uninterruptible,
        Effect.tapError(
          Match.type<AnalysisError>().pipe(
            Match.tag("AnalyzerUnavailable", () => stop),
            Match.orElse(() => Effect.void),
          ),
        ),
      ),
    )

  return { use }
})

interface Loaded {
  readonly tsconfig: string
  readonly project: Project
}

interface Entry {
  readonly path: FilePath
  readonly programFileName: string
  readonly realPath: string
  readonly project: Project
}

const READ_CONCURRENCY = 16

const normalize = (file: string): string => file.replaceAll("\\", "/")

const joined = (path: FilePath): string => path.join("/")

const isRelative = (specifier: string, isAbsolute: (path: string) => boolean): boolean =>
  specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../") || isAbsolute(specifier)

export const makeTypescript: Effect.Effect<AnalyzerShape, never, FileSystem.FileSystem | Path.Path | Scope.Scope> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const server = yield* makeServer

  const platform = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, AnalyzerUnavailable> => effect.pipe(Effect.mapError(unavailable))

  const describeDiagnostic =
    (root: string): ((diagnostic: Diagnostic) => string) =>
    (diagnostic: Diagnostic): string => {
      const relative = diagnostic.fileName === undefined ? undefined : path.relative(root, diagnostic.fileName)
      const file = relative === undefined ? undefined : relative.startsWith("..") ? diagnostic.fileName : relative
      return `${file === undefined ? "" : `${file}: `}TS${diagnostic.code}: ${diagnostic.text}`
    }

  const loadProject = (remote: Remote, snapshot: Snapshot, root: string, tsconfig: string): Effect.Effect<Loaded, AnalyzerUnavailable | ProjectParseFailed> =>
    Effect.gen(function* () {
      const project = snapshot.getProject(path.join(root, tsconfig))
      if (project === undefined) {
        return yield* unavailable(new Error(`TypeScript did not open ${tsconfig}`))
      }
      const errors = (yield* remote.request(() => project.program.getConfigFileParsingDiagnostics())).filter(
        (diagnostic) => diagnostic.category === DiagnosticCategory.Error,
      )
      if (errors.length > 0) {
        return yield* new ProjectParseFailed({ tsconfig, diagnostics: errors.map(describeDiagnostic(root)) })
      }
      return { tsconfig, project }
    })

  const locate = (root: string, tsconfig: string): Effect.Effect<void, AnalyzerUnavailable | ProjectNotFound> =>
    Effect.gen(function* () {
      if (!(yield* platform(fs.exists(path.resolve(root, tsconfig))))) {
        return yield* new ProjectNotFound({ tsconfig })
      }
    })

  const sourceSet = (root: string, projects: ReadonlyArray<Loaded>): Effect.Effect<Array<Entry>, AnalyzerUnavailable> =>
    Effect.gen(function* () {
      const entries = new Map<string, Entry>()
      for (const { project } of projects) {
        const candidates = project.rootFiles.filter(
          (fileName) => !isDeclarationFileName(fileName) && !isJsonFileName(fileName) && !isInstalled(splitPath(fileName)),
        )
        const real = yield* Effect.forEach(candidates, (fileName) => platform(fs.realPath(fileName)), { concurrency: 16 })
        candidates.forEach((fileName, index) => {
          const realPath = normalize(real[index] ?? fileName)
          const relative = path.relative(root, realPath)
          const segments = splitPath(relative)
          const inside = segments.length > 0 && segments[0] !== ".." && !path.isAbsolute(relative)
          if (inside && !isInstalled(segments) && !entries.has(realPath)) {
            entries.set(realPath, { path: segments, programFileName: fileName, realPath, project })
          }
        })
      }
      return [...entries.values()].toSorted((left, right) => compareCodeUnits(joined(left.path), joined(right.path)))
    })

  const makeTargets = (entries: ReadonlyArray<Entry>, caseSensitive: boolean): Targets => {
    const fold = (file: string): string => (caseSensitive ? normalize(file) : normalize(file).toLowerCase())
    const files = new Map(entries.map((entry) => [fold(entry.realPath), entry.path] as const))
    const probes = new Map<string, boolean>()
    const through = new Map<string, FilePath | undefined>()

    const hasPackage = (directory: string, name: string): Effect.Effect<boolean, AnalyzerUnavailable> =>
      Effect.gen(function* () {
        const key = `${directory}\0${name}`
        const known = probes.get(key)
        if (known !== undefined) {
          return known
        }
        const parent = path.dirname(directory)
        const found =
          (yield* platform(fs.exists(path.join(directory, NODE_MODULES, name)))) ||
          (parent !== directory && (yield* hasPackage(parent, name)))
        probes.set(key, found)
        return found
      })

    const probedPackage = (specifier: string, directory: string): Effect.Effect<Target, AnalyzerUnavailable> =>
      Effect.gen(function* () {
        const written = specifierPackage(specifier)
        return written !== undefined && (yield* hasPackage(directory, written.name))
          ? { _tag: "Package", name: written.name, subpath: written.subpath }
          : { _tag: "Unresolved", specifier }
      })

    const relativeFile = (specifier: string, directory: string): Target => {
      const hit = fileCandidates(path.resolve(directory, specifier)).find((candidate) => files.has(fold(candidate)))
      const found = hit === undefined ? undefined : files.get(fold(hit))
      return found === undefined ? { _tag: "Unresolved", specifier } : { _tag: "File", path: found }
    }

    const sourceFileAt = (modulePath: string): Effect.Effect<FilePath | undefined> => {
      const direct = files.get(fold(modulePath))
      if (direct !== undefined || through.has(modulePath)) {
        return Effect.succeed(direct ?? through.get(modulePath))
      }
      return fs.realPath(modulePath).pipe(
        Effect.map((real) => files.get(fold(real))),
        Effect.orElseSucceed(() => undefined),
        Effect.tap((found) => Effect.sync(() => through.set(modulePath, found))),
      )
    }

    const moduleTarget = (specifier: string, module: { readonly path: string; readonly isFile: boolean }): Effect.Effect<Target> => {
      const unresolved: Target = { _tag: "Unresolved", specifier }
      const segments = splitPath(module.path)
      return isInstalled(segments)
        ? Effect.succeed(packageTarget(specifier, installedPackage(segments)) ?? unresolved)
        : module.isFile
          ? Effect.map(sourceFileAt(module.path), (found): Target => (found === undefined ? unresolved : { _tag: "File", path: found }))
          : Effect.succeed(unresolved)
    }

    const orBuiltin = (specifier: string, otherwise: () => Effect.Effect<Target, AnalyzerUnavailable>): Effect.Effect<Target, AnalyzerUnavailable> => {
      const builtin = builtinTarget(specifier)
      return builtin === undefined ? otherwise() : Effect.succeed(builtin)
    }

    const target = (dependency: RawDependency, directory: string): Effect.Effect<Target, AnalyzerUnavailable> =>
      Match.valueTags(dependency.resolution, {
        Computed: () => Effect.succeed<Target>({ _tag: "Computed" }),
        Module: (module) => orBuiltin(dependency.specifier, () => moduleTarget(dependency.specifier, module)),
        Missing: () => orBuiltin(dependency.specifier, () => probedPackage(dependency.specifier, directory)),
        Unchecked: () =>
          orBuiltin(dependency.specifier, () =>
            isRelative(dependency.specifier, path.isAbsolute)
              ? Effect.succeed(relativeFile(dependency.specifier, directory))
              : probedPackage(dependency.specifier, directory),
          ),
      })

    return { target }
  }

  const read = (remote: Remote, entry: Entry): Effect.Effect<Read, AnalyzerUnavailable> =>
    remote.request(async (): Promise<Read> => {
      const sourceFile = await entry.project.program.getSourceFile(entry.programFileName)
      if (sourceFile === undefined) {
        throw new Error(`TypeScript did not load ${entry.programFileName}`)
      }
      return { raw: await readSource(entry.project, sourceFile), caseSensitive: sourceFile.path === normalize(sourceFile.fileName) }
    })

  const assemble = (entry: Entry, raw: RawSource, targets: Targets): Effect.Effect<SourceFile, AnalyzerUnavailable> =>
    Effect.gen(function* () {
      const directory = path.dirname(entry.realPath)
      const dependencies = yield* Effect.forEach(raw.dependencies, (dependency) =>
        Effect.map(targets.target(dependency, directory), (target) => ({
          target,
          kind: dependency.kind,
          specifier: dependency.specifier,
          location: dependency.location,
        })),
      )
      return {
        path: entry.path,
        dependencies,
        declarations: raw.declarations,
        exports: raw.exports,
        uses: raw.uses,
        lines: raw.lines,
      } satisfies SourceFile
    })

  /**
   * The server keeps tsconfig file lists and file contents between snapshots.
   * Closing the projects, invalidating, and reporting the tsconfigs as changed
   * makes it list and read everything again; the client's copies must go too.
   */
  const reset = ({ api, request }: Remote, configPaths: ReadonlyArray<string>): Effect.Effect<void, AnalyzerUnavailable> =>
    request(async (): Promise<void> => {
      await (await api.updateSnapshot({ closeProjects: [...configPaths] })).dispose()
      await (await api.updateSnapshot({ fileChanges: { invalidateAll: true } })).dispose()
      await (await api.updateSnapshot({ fileChanges: { changed: [...configPaths] } })).dispose()
      api.clearSourceFileCache()
    })

  const analyzeWith = (remote: Remote, root: string, tsconfigs: ReadonlyArray<string>): Effect.Effect<Graph, AnalysisError> => {
    const configPaths = tsconfigs.map((tsconfig) => path.join(root, tsconfig))
    return Effect.acquireUseRelease(
      reset(remote, configPaths).pipe(Effect.andThen(remote.request(() => remote.api.updateSnapshot({ openProjects: [...configPaths] })))),
      (snapshot) =>
        Effect.gen(function* () {
          const projects = yield* Effect.forEach(tsconfigs, (tsconfig) => loadProject(remote, snapshot, root, tsconfig))
          const entries = yield* sourceSet(root, projects)
          const sources = yield* Effect.forEach(entries, (entry) => read(remote, entry), { concurrency: READ_CONCURRENCY })
          const targets = makeTargets(
            entries,
            sources.every(({ caseSensitive }) => caseSensitive),
          )
          const files = yield* Effect.forEach(entries, (entry, index) => {
            const source = sources[index]
            return source === undefined
              ? Effect.fail(unavailable(new Error(`no source read for ${entry.programFileName}`)))
              : assemble(entry, source.raw, targets)
          })
          return { files } satisfies Graph
        }),
      (snapshot) =>
        remote.request(async (): Promise<void> => {
          await snapshot.dispose()
          await (await remote.api.updateSnapshot({ closeProjects: [...configPaths] })).dispose()
        }).pipe(Effect.ignore),
    )
  }

  const analyze: (workspace: Workspace) => Effect.Effect<Graph, AnalysisError> = Effect.fn("Analyzer.typescript.analyze")(function* (workspace: Workspace) {
    yield* Effect.forEach(workspace.projects, (tsconfig) => locate(workspace.root, tsconfig))
    const root = normalize(yield* platform(fs.realPath(workspace.root)))
    return yield* server.use((remote) => analyzeWith(remote, root, workspace.projects))
  })

  return { analyze } satisfies AnalyzerShape
})
