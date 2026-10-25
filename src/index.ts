import { Cause, Exit, ManagedRuntime, Result } from "effect"
import { type ArcherConfig, defineConfig } from "./config/input.ts"
import type { Graph, SourceFile } from "./core/model.ts"
import { ArcherLive, type ArcherServices } from "./effect.ts"
import { type Format, render } from "./report/render.ts"
import type { Report } from "./report/report.ts"
import { checkGraph, run as runEffect, type RunOptions, type RunResult } from "./run.ts"

export { defineConfig, type ArcherConfig }
export { p, presets, r, use, type CustomCheck, type CustomContext, type RuleSpec, type SelectorInput } from "./config/rules.ts"
export type { Format, Graph, Report, RunOptions, RunResult }
export type { BaselineMode } from "./run.ts"

type ArcherRuntime = ManagedRuntime.ManagedRuntime<ArcherServices, never>

const makeRuntime = (): ArcherRuntime => ManagedRuntime.make(ArcherLive)

let runtime: ArcherRuntime | undefined

const shared = (): ArcherRuntime => (runtime ??= makeRuntime())

/** Errors keep their `_tag` (`ConfigNotFound`, `ConfigInvalid`, `ProjectParseFailed`, …) and `instanceof Error`. */
const settle = async <A, E>(exit: Exit.Exit<A, E>): Promise<A> => {
  if (Exit.isSuccess(exit)) {
    return exit.value
  }
  throw Cause.squash(exit.cause)
}

/** Loads the configuration, analyzes the workspace, and applies the baseline. */
export const run = async (options: RunOptions = {}): Promise<RunResult> =>
  settle(await shared().runPromiseExit(runEffect(options)))

export const renderReport = async (result: RunResult, format: Format = "pretty"): Promise<string> =>
  shared().runPromise(render(format, result.report, result.graph, { root: result.root }))

export class ArchitectureError extends Error {
  readonly report: Report

  constructor(report: Report, message: string) {
    super(message)
    this.name = "ArchitectureError"
    this.report = report
  }
}

/** Rejects with an `ArchitectureError`, whose message is the pretty report, when the verdict is fail. */
export const assertArchitecture = async (options: RunOptions = {}): Promise<Report> => {
  const result = await run(options)
  if (result.report.verdict === "fail") {
    throw new ArchitectureError(result.report, await renderReport(result))
  }
  return result.report
}

/** Checks a configuration against a graph built in memory: no TypeScript and no files. Throws on an invalid configuration. */
export const check = (config: ArcherConfig, graph: Graph): Report => Result.getOrThrow(checkGraph(config, graph))

/** A graph from an adjacency table of root-relative paths, for testing a policy. */
export const graphOf = (adjacency: Readonly<Record<string, ReadonlyArray<string>>>): Graph => ({
  files: Object.entries(adjacency).map(
    ([path, imports]): SourceFile => ({
      path: path.split("/"),
      dependencies: imports.map((target, index) => ({
        target: { _tag: "File", path: target.split("/") },
        kind: "static",
        specifier: target,
        location: { line: index + 1, column: 1 },
      })),
      declarations: [],
      exports: [],
      uses: [],
      lines: 0,
    }),
  ),
})

/** Stops the TypeScript server that `run` started. */
export const dispose = async (): Promise<void> => {
  const current = runtime
  runtime = undefined
  await current?.dispose()
}

