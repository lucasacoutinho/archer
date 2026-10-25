import { Effect, FileSystem, Match, Path, Result, Schema } from "effect"
import { Analyzer } from "./analyzer/Analyzer.ts"
import type { AnalysisError } from "./analyzer/errors.ts"
import { apply, record } from "./core/baseline.ts"
import { check, emptyObjects, emptySubjects } from "./core/check.ts"
import { ConfigError } from "./core/config.ts"
import { structuralKey } from "./core/structural.ts"
import type { FilePath, Graph } from "./core/model.ts"
import type { CustomRules, Policy } from "./core/rule.ts"
import { lower } from "./core/lower.ts"
import { type ArcherConfig, type Configuration, ConfigInvalid, decodeConfiguration } from "./config/input.ts"
import { makeReport, type Report, type RuleInfo } from "./report/report.ts"
import { type BaselineError, readBaseline, writeBaseline } from "./shell/baseline-file.ts"
import { configFileNames, type ConfigLoadError, importConfig } from "./shell/load-config.ts"

export type BaselineMode = "apply" | "ignore" | "record" | "prune"

export interface RunOptions {
  /** A configuration, or the path of a configuration file. Without it, the first `archer.config.*` in `cwd`. */
  readonly config?: ArcherConfig | string
  readonly cwd?: string
  readonly baseline?: BaselineMode
}

export interface RunResult {
  readonly report: Report
  readonly graph: Graph
  readonly root: string
}

export class ConfigNotFound extends Schema.TaggedError<ConfigNotFound, { readonly brand: unique symbol }>()(
  "ConfigNotFound",
  { searched: Schema.Array(Schema.String) },
) {}

export class ConfigRejected extends Schema.TaggedError<ConfigRejected, { readonly brand: unique symbol }>()(
  "ConfigRejected",
  { error: ConfigError },
) {}

export type RunError = ConfigNotFound | ConfigLoadError | ConfigInvalid | ConfigRejected | AnalysisError | BaselineError

const locate: (
  cwd: string,
  config: string | undefined,
) => Effect.Effect<string, ConfigNotFound, FileSystem.FileSystem | Path.Path> = Effect.fn("locateConfig")(function* (cwd: string, config: string | undefined) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const candidates = config === undefined ? configFileNames.map((name) => path.join(cwd, name)) : [path.resolve(cwd, config)]
  for (const candidate of candidates) {
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return candidate
    }
  }
  return yield* new ConfigNotFound({ searched: candidates })
})

interface Loaded {
  readonly configuration: Configuration
  readonly base: string
  readonly file: string | undefined
}

const load: (
  options: RunOptions,
) => Effect.Effect<Loaded, ConfigNotFound | ConfigLoadError | ConfigInvalid, FileSystem.FileSystem | Path.Path> =
  Effect.fn("loadConfig")(function* (options: RunOptions) {
  const path = yield* Path.Path
  const cwd = path.resolve(options.cwd ?? ".")
  if (typeof options.config === "object") {
    return { configuration: yield* decode(options.config), base: cwd, file: undefined }
  }
  const file = yield* locate(cwd, options.config)
  return { configuration: yield* decode(yield* importConfig(file)), base: path.dirname(file), file }
})

export interface WorkspaceLocation {
  /** The directory the analysis reads. */
  readonly root: string
  /** The configuration file, when the configuration came from one. */
  readonly configFile: string | undefined
}

/** Where a run would analyze, without analyzing: what a watcher needs to watch. */
export const locateWorkspace: (
  options: RunOptions,
) => Effect.Effect<WorkspaceLocation, ConfigNotFound | ConfigLoadError | ConfigInvalid, FileSystem.FileSystem | Path.Path> =
  Effect.fn("locateWorkspace")(function* (options: RunOptions) {
    const path = yield* Path.Path
    const { configuration, base, file } = yield* load(options)
    return { root: path.resolve(base, configuration.root), configFile: file }
  })

const decode = (input: unknown): Effect.Effect<Configuration, ConfigInvalid> => Effect.fromResult(decodeConfiguration(input))

const customRules =
  (configuration: Configuration): CustomRules =>
  (name: string, graph: Graph, subject: FilePath): ReadonlyArray<string> =>
    configuration.custom.get(name)?.({ graph, subject: subject.join("/") }) ?? []

/** User rules carry their reason; layer and public-API rules come from lowering. */
const ruleInfo = (configuration: Configuration, policy: Policy): Array<RuleInfo> => {
  const described = new Map(configuration.rules.map((rule) => [rule.id, rule]))
  return policy.map((rule) => described.get(rule.id) ?? { id: rule.id, severity: rule.severity })
}

/** Decode, lower, and check: the pure part of a run, for a graph built by the caller. */
export const checkGraph = (
  input: ArcherConfig,
  graph: Graph,
): Result.Result<Report, ConfigInvalid | ConfigRejected> =>
  Result.flatMap(decodeConfiguration(input), (configuration) =>
    Result.mapBoth(lower(configuration.config), {
      onFailure: (error) => new ConfigRejected({ error }),
      onSuccess: (policy) =>
        makeReport({
          applied: apply([], check(customRules(configuration), policy, graph)),
          emptySubjects: emptySubjects(policy, graph),
          emptyObjects: emptyObjects(policy, graph),
          rules: ruleInfo(configuration, policy),
          graph,
          failOnWarnings: configuration.failOnWarnings,
        }),
    }),
  )

export const run: (
  options?: RunOptions,
) => Effect.Effect<RunResult, RunError, Analyzer | FileSystem.FileSystem | Path.Path> = Effect.fn("run")(function* (options: RunOptions = {}) {
  const path = yield* Path.Path
  const analyzer = yield* Analyzer
  const { configuration, base } = yield* load(options)
  const policy = yield* Effect.fromResult(lower(configuration.config)).pipe(
    Effect.mapError((error) => new ConfigRejected({ error })),
  )
  const root = path.resolve(base, configuration.root)
  const graph = yield* analyzer.analyze({ root, projects: configuration.projects })
  const violations = check(customRules(configuration), policy, graph)
  const baselineFile = configuration.baseline === undefined ? undefined : path.resolve(root, configuration.baseline)
  const current = record(violations)
  const baseline =
    baselineFile === undefined
      ? []
      : yield* Match.value(options.baseline ?? "apply").pipe(
          Match.when("ignore", () => Effect.succeed([])),
          Match.when("apply", () => readBaseline(baselineFile)),
          Match.when("record", () => writeBaseline(baselineFile, current).pipe(Effect.as(current))),
          Match.when("prune", () =>
            readBaseline(baselineFile).pipe(
              Effect.map((stored) => {
                const live = new Set(current.map(structuralKey))
                return stored.filter((entry) => live.has(structuralKey(entry)))
              }),
              Effect.tap((kept) => writeBaseline(baselineFile, kept)),
            ),
          ),
          Match.exhaustive,
        )
  const report = makeReport({
    applied: apply(baseline, violations),
    emptySubjects: emptySubjects(policy, graph),
    emptyObjects: emptyObjects(policy, graph),
    rules: ruleInfo(configuration, policy),
    graph,
    failOnWarnings: configuration.failOnWarnings,
  })
  return { report, graph, root } satisfies RunResult
})
