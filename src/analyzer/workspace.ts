import { isAbsolute } from "node:path"
import { type Effect, Schema } from "effect"
import type { Graph } from "../core/model.ts"
import type { AnalysisError } from "./errors.ts"

export const AbsolutePath: Schema.Codec<string> = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.makeFilter((path) => isAbsolute(path) || "must be an absolute path"),
)

export const RootRelativePath: Schema.Codec<string> = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.makeFilter((path) => !isAbsolute(path) || "must be relative to the workspace root"),
)

/**
 * What to analyze: the root directory and the tsconfig projects to load. The
 * source files are the union of the projects' file lists. A file in several
 * projects is analyzed through the first one in `projects` order.
 */
export interface Workspace {
  readonly root: string
  readonly projects: readonly [string, ...Array<string>]
}

export const Workspace: Schema.Codec<Workspace> = Schema.Struct({
  root: AbsolutePath,
  projects: Schema.NonEmptyArray(RootRelativePath),
})
export interface AnalyzerShape {
  /**
   * The whole graph for the workspace, or an error; never a partial graph.
   * Each call reads the files again, so a watcher can call it repeatedly.
   * Concurrent calls run one after another.
   */
  readonly analyze: (workspace: Workspace) => Effect.Effect<Graph, AnalysisError>
}
