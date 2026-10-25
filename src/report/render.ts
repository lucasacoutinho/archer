import { Effect, type FileSystem, Match, type Path, Schema } from "effect"
import type { Graph } from "../core/model.ts"
import { agent } from "./agent.ts"
import { dot } from "./dot.ts"
import { github } from "./github.ts"
import { json } from "./json.ts"
import { pretty, type PrettyOptions } from "./pretty.ts"
import type { Report } from "./report.ts"
import { sarif } from "./sarif.ts"

export type Format = "pretty" | "agent" | "json" | "sarif" | "github" | "dot"
export const Format: Schema.Codec<Format> = Schema.Literals(["pretty", "agent", "json", "sarif", "github", "dot"])

export type RenderOptions = PrettyOptions

export const render = (
  format: Format,
  report: Report,
  graph: Graph,
  options: RenderOptions,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
  Match.value(format).pipe(
    Match.when("pretty", () => pretty(report, options)),
    Match.when("agent", () => Effect.succeed(agent(report))),
    Match.when("json", () => Effect.succeed(json(report))),
    Match.when("sarif", () => Effect.succeed(sarif(report))),
    Match.when("github", () => Effect.succeed(github(report))),
    Match.when("dot", () => Effect.succeed(dot(graph))),
    Match.exhaustive,
  )
