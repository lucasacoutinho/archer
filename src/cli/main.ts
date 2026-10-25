#!/usr/bin/env node
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Deferred, Duration, Effect, Fiber, FileSystem, Option, Path, type PlatformError, Schema, Semaphore, Stream } from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"
import { Analyzer } from "../analyzer/Analyzer.ts"
import { formatGraphFile } from "../analyzer/graph-file.ts"
import { type Format, render } from "../report/render.ts"
import { type BaselineMode, locateWorkspace, run, type RunError } from "../run.ts"
import { explain } from "./explain.ts"


const formats: ReadonlyArray<Format> = ["pretty", "agent", "json", "sarif", "github", "dot"]
const defaultFormat: Format = "pretty"

const config: Flag.Flag<Option.Option<string>> = Flag.String("config").pipe(
  Flag.withAlias("c"),
  Flag.withDescription("Configuration file. Default: the first archer.config.{ts,mts,js,mjs} in the current directory."),
  Flag.optional,
)

/** A run that Archer cannot complete prints why and exits 2, keeping 1 for a failing report. */
const attempt = <A, R>(effect: Effect.Effect<A, RunError, R>): Effect.Effect<Option.Option<A>, never, R> =>
  effect.pipe(
    Effect.asSome,
    Effect.catch((error) =>
      Console.error(explain(error)).pipe(
        Effect.andThen(Effect.sync(() => (process.exitCode = 2))),
        Effect.as(Option.none<A>()),
      ),
    ),
  )

const runOnce = (options: {
  readonly config: Option.Option<string>
  readonly reporter: Format
  readonly output: Option.Option<string>
  readonly baseline: BaselineMode
}): Effect.Effect<Option.Option<string>, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path | Analyzer> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const outcome = yield* attempt(
      run({ ...(Option.isSome(options.config) ? { config: options.config.value } : {}), baseline: options.baseline }),
    )
    if (Option.isNone(outcome)) {
      return Option.none<string>()
    }
    const result = outcome.value
    const color = Option.isNone(options.output) && process.stdout.isTTY === true
    const text = yield* render(options.reporter, result.report, result.graph, { root: result.root, color })
    if (Option.isSome(options.output)) {
      yield* fs.writeFileString(options.output.value, `${text}\n`)
    } else if (text !== "") {
      yield* Console.log(text)
    }
    process.exitCode = result.report.verdict === "fail" ? 1 : 0
    return Option.some(result.root)
  })


/** Watch event paths use the platform separator: `/`, or `\` on Windows. */
const ignored = (changed: string): boolean =>
  changed
    .split("\\")
    .flatMap((part) => part.split("/"))
    .some((segment) => segment === "node_modules" || segment === ".git")

/** The `check` invocation that a watcher repeats: the same flags, without `--watch`. */
const checkArguments = (input: CheckInput): Array<string> => [
  "check",
  ...(Option.isSome(input.config) ? ["--config", input.config.value] : []),
  "--reporter",
  input.reporter,
  ...(Option.isSome(input.output) ? ["--output", input.output.value] : []),
  ...(input.ignoreBaseline ? ["--ignore-baseline"] : []),
  ...(Option.isSome(input.graph) ? ["--graph", input.graph.value] : []),
]

const entry: string = fileURLToPath(import.meta.url)

/** One check in a fresh Node process, so every module reloads and nothing is retained between runs. */
const checkInChild = (args: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.callback<void>((resume): Effect.Effect<void> => {
    const child = spawn(process.execPath, [...process.execArgv, entry, ...args], { stdio: "inherit" })
    child.once("exit", () => resume(Effect.void))
    child.once("error", (error) => resume(Console.error(`archer: could not start a check: ${error.message}`)))
    return Effect.sync(() => {
      child.kill()
      setTimeout(() => child.kill("SIGKILL"), 3_000).unref()
    })
  })

/**
 * Runs the check, then again after each change under the workspace root or
 * beside the configuration file, which covers modules the configuration
 * imports. This process never loads TypeScript or the user's rules twice.
 */
const watchChecks = (input: CheckInput): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const location = yield* attempt(locateWorkspace(Option.isSome(input.config) ? { config: input.config.value } : {}))
    if (Option.isNone(location)) {
      return
    }
    const args = checkArguments(input)
    const { root, configFile } = location.value
    const report = Option.isSome(input.output) ? path.resolve(input.output.value) : undefined
    const relevant = (directory: string, changed: string): boolean =>
      !ignored(changed) && path.resolve(directory, changed) !== report
    const rootReady = yield* Deferred.make<void>()
    const configReady = yield* Deferred.make<void>()
    const changes = fs
      .watch(root, { recursive: true, onReady: () => Deferred.doneUnsafe(rootReady, Effect.void) })
      .pipe(Stream.filter((event) => relevant(root, event.path)))
    const configChanges =
      configFile === undefined
        ? Stream.fromEffect(Deferred.succeed(configReady, undefined)).pipe(Stream.drain)
        : fs
            .watch(path.dirname(configFile), { onReady: () => Deferred.doneUnsafe(configReady, Effect.void) })
            .pipe(Stream.filter((event) => relevant(path.dirname(configFile), event.path)))
    const lock = yield* Semaphore.make(1)
    const checkOnce = lock.withPermit(checkInChild(args))
    const watching = yield* Stream.merge(changes, configChanges).pipe(
      Stream.debounce(Duration.millis(200)),
      Stream.runForEach(() => checkOnce),
      Effect.forkChild,
    )
    // Watch before the first check, so an edit made while it runs is not missed.
    yield* Deferred.await(rootReady)
    yield* Deferred.await(configReady)
    yield* checkOnce
    yield* Fiber.join(watching)
  })

interface CheckInput {
  readonly config: Option.Option<string>
  readonly reporter: Format
  readonly output: Option.Option<string>
  readonly watch: boolean
  readonly ignoreBaseline: boolean
  readonly graph: Option.Option<string>
}

interface BaselineInput {
  readonly config: Option.Option<string>
  readonly mode: "record" | "prune"
}

interface GraphInput {
  readonly config: Option.Option<string>
  readonly output: string
}

const check: Command.Command<"check", CheckInput, {}, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> = Command.make(
  "check",
  {
    config,
    reporter: Flag.Literals("reporter", formats).pipe(Flag.withAlias("r"), Flag.withDefault(defaultFormat)),
    output: Flag.String("output").pipe(Flag.withAlias("o"), Flag.withDescription("Write the report to a file."), Flag.optional),
    watch: Flag.Boolean("watch").pipe(Flag.withAlias("w"), Flag.withDefault(false)),
    ignoreBaseline: Flag.Boolean("ignore-baseline").pipe(
      Flag.withDescription("Report every violation, including those the baseline accepts."),
      Flag.withDefault(false),
    ),
    graph: Flag.String("graph").pipe(
      Flag.withDescription("Check a graph saved by `archer graph` instead of analyzing the workspace."),
      Flag.optional,
    ),
  },
  Effect.fn("archer.check")(function* (input: CheckInput) {
    if (input.watch) {
      return yield* watchChecks(input)
    }
    yield* runOnce({
      config: input.config,
      reporter: input.reporter,
      output: input.output,
      baseline: input.ignoreBaseline ? "ignore" : "apply",
    }).pipe(Effect.provide(Option.isSome(input.graph) ? Analyzer.replay(input.graph.value) : Analyzer.typescript))
  }),
).pipe(
  Command.withDescription("Check the architecture. Exits 1 when the report fails, 2 when Archer cannot check."),
)

const baseline: Command.Command<"baseline", BaselineInput, {}, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> = Command.make(
  "baseline",
  { config, mode: Argument.Literals("mode", ["record", "prune"] as const) },
  Effect.fn("archer.baseline")(function* ({ config, mode }) {
    const recorded = yield* runOnce({ config, reporter: "agent", output: Option.none(), baseline: mode }).pipe(
      Effect.provide(Analyzer.typescript),
    )
    if (Option.isSome(recorded)) {
      process.exitCode = 0
    }
  }),
).pipe(Command.withDescription("record: accept every current violation. prune: drop entries no violation has."))

const graph: Command.Command<"graph", GraphInput, {}, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> = Command.make(
  "graph",
  {
    config,
    output: Flag.String("output").pipe(Flag.withAlias("o"), Flag.withDescription("The graph file to write.")),
  },
  Effect.fn("archer.graph")(function* ({ config, output }) {
    const fs = yield* FileSystem.FileSystem
    const result = yield* attempt(
      run({ ...(Option.isSome(config) ? { config: config.value } : {}), baseline: "ignore" }).pipe(
        Effect.provide(Analyzer.typescript),
      ),
    )
    if (Option.isSome(result)) {
      yield* fs.writeFileString(output, formatGraphFile(result.value.graph))
      yield* Console.log(`Wrote ${result.value.graph.files.length} files to ${output}`)
    }
  }),
).pipe(Command.withDescription("Save the analyzed graph, for `archer check --graph` or a bug report."))

const template: string = `import { defineConfig, presets, r } from "@lucasacoutinho/archer"

export default defineConfig({
  layers: {
    app: "src/app",
    domain: "src/domain",
    infrastructure: "src/infrastructure",
  },
  stack: ["app", "domain"],
  allow: { infrastructure: ["domain"] },
  rules: [...presets.recommended, r.forbid("domain/pure", "layer:domain", ["npm:*", "node:*"])],
})
`

const init: Command.Command<"init", {}, {}, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> = Command.make(
  "init",
  {},
  Effect.fn("archer.init")(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = path.resolve("archer.config.ts")
    if (yield* fs.exists(file)) {
      process.exitCode = 1
      return yield* Console.error(`${file} already exists`)
    }
    yield* fs.writeFileString(file, template)
    yield* Console.log(`Created ${file}`)
  }),
).pipe(Command.withDescription("Create a starter archer.config.ts."))

const { version }: { readonly version: string } = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }))(
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")),
)

const archer: Command.Command<"archer", {}, {}, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> = Command.make("archer").pipe(Command.withSubcommands([check, baseline, graph, init]))

archer.pipe(
  Command.run({ version }),
  Effect.catchIf(CliError.isCliError, () => Effect.sync(() => (process.exitCode = 2))),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)
