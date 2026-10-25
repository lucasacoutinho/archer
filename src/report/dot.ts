import { Match } from "effect"
import type { DependencyKind, Graph } from "../core/model.ts"
import { pathText } from "./message.ts"

const quoted = (text: string): string =>
  `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`

const attributes = (kind: DependencyKind): string =>
  Match.value(kind).pipe(
    Match.when("static", () => ""),
    Match.when("type", () => ' [label="type", style=dashed]'),
    Match.when("require", () => ' [label="require"]'),
    Match.when("dynamic", () => ' [label="dynamic", style=dotted]'),
    Match.exhaustive,
  )

/** Nodes and edges are sorted and deduplicated, so the output does not depend on the graph's file order. */
export const dot = (graph: Graph): string => {
  const nodes = graph.files.map((file) => `  ${quoted(pathText(file.path))};`)
  const edges = graph.files.flatMap((file) =>
    file.dependencies.flatMap(({ target, kind }) =>
      Match.value(target).pipe(
        Match.tag("File", ({ path }) => [
          `  ${quoted(pathText(file.path))} -> ${quoted(pathText(path))}${attributes(kind)};`,
        ]),
        Match.orElse(() => []),
      ),
    ),
  )
  const sorted = (lines: ReadonlyArray<string>): Array<string> => Array.from(new Set(lines)).sort()
  const header = ["digraph archer {", "  rankdir=LR;", "  node [shape=box];"]
  return [...header, ...sorted(nodes), ...sorted(edges), "}"].join("\n")
}
