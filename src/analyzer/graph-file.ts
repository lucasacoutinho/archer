import { Effect, FileSystem, Schema } from "effect"
import { Graph } from "../core/model.ts"
import { GraphFileInvalid } from "./errors.ts"

/** A saved analysis. The version changes whenever the Graph schema does. */
export interface GraphFile {
  readonly format: "archer-graph"
  readonly version: 1
  readonly graph: Graph
}

export const GraphFile: Schema.Codec<GraphFile> = Schema.Struct({
  format: Schema.Literal("archer-graph"),
  version: Schema.Literal(1),
  graph: Graph,
})

export const formatGraphFile = (graph: Graph): string =>
  `${JSON.stringify(Schema.encodeSync(GraphFile)({ format: "archer-graph", version: 1, graph }))}\n`

export const readGraphFile: (path: string) => Effect.Effect<Graph, GraphFileInvalid, FileSystem.FileSystem> = Effect.fn("readGraphFile")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs
    .readFileString(path)
    .pipe(Effect.mapError((error) => new GraphFileInvalid({ path, issue: error.message })))
  const json = yield* Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: () => new GraphFileInvalid({ path, issue: "not JSON" }),
  })
  const file = yield* Schema.decodeUnknownEffect(GraphFile)(json).pipe(
    Effect.mapError((error) => new GraphFileInvalid({ path, issue: error.message })),
  )
  return file.graph
})
