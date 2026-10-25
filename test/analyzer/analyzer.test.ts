import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Layer } from "effect"
import { Analyzer } from "../../src/analyzer/Analyzer.ts"
import { formatGraphFile } from "../../src/analyzer/graph-file.ts"
import { analyzerContract } from "./contract.ts"

const typescript = Analyzer.typescript.pipe(Layer.provide(NodeServices.layer))

analyzerContract("typescript", () => typescript)

analyzerContract("memory of the typescript output", (workspace) =>
  Layer.unwrap(
    Analyzer.use((analyzer) => analyzer.analyze(workspace)).pipe(
      Effect.provide(typescript),
      Effect.map(Analyzer.memory),
    ),
  ),
)

analyzerContract("replay of the typescript output", (workspace) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const graph = yield* Analyzer.use((analyzer) => analyzer.analyze(workspace)).pipe(Effect.provide(typescript))
      const file = yield* fs.makeTempFileScoped({ prefix: "archer-graph-" })
      yield* fs.writeFileString(file, formatGraphFile(graph))
      return Analyzer.replay(file)
    }).pipe(Effect.orDie),
  ).pipe(Layer.provide(NodeServices.layer)),
)
