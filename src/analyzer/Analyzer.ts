/** The only part of Archer that talks to TypeScript. Contract: docs/architecture.md#analyzer. */
import { Context, Effect, FileSystem, Layer, type Path } from "effect"
import type { Graph } from "../core/model.ts"
import { AnalyzerUnavailable, type AnalysisError, GraphFileInvalid, ProjectNotFound, ProjectParseFailed } from "./errors.ts"
import { readGraphFile } from "./graph-file.ts"
import { makeTypescript } from "./typescript.ts"
import type { AnalyzerShape } from "./workspace.ts"

export { AbsolutePath, RootRelativePath, Workspace } from "./workspace.ts"

export { AnalyzerUnavailable, GraphFileInvalid, ProjectNotFound, ProjectParseFailed }
export type { AnalysisError }

export class Analyzer extends Context.Service<Analyzer, AnalyzerShape>()("archer/Analyzer") {
  /** TypeScript's native API. The server starts on the first `analyze` and stops with the layer's scope. */
  static readonly typescript: Layer.Layer<Analyzer, never, FileSystem.FileSystem | Path.Path> = Layer.effect(Analyzer, makeTypescript)

  static readonly memory = (graph: Graph): Layer.Layer<Analyzer> =>
    Layer.succeed(Analyzer, Analyzer.of({ analyze: () => Effect.succeed(graph) }))

  /** A graph saved by `archer graph`, read again on every `analyze`; the workspace is not consulted. */
  static readonly replay = (path: string): Layer.Layer<Analyzer, never, FileSystem.FileSystem> =>
    Layer.effect(
      Analyzer,
      Effect.map(FileSystem.FileSystem, (fs) =>
        Analyzer.of({ analyze: () => readGraphFile(path).pipe(Effect.provideService(FileSystem.FileSystem, fs)) }),
      ),
    )
}
