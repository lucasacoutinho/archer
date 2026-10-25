import type { Dependency, DependencyKind, EdgeFilter, FilePath, Graph, Selector, SourceFile, Target } from "../../src/core/model.ts"
import type { Edge, Rule, Severity } from "../../src/core/rule.ts"
import type { Assertion } from "../../src/core/rule.ts"

export const loc = { line: 1, column: 1 }

export const file = (path: string): Target => ({ _tag: "File", path: path.split("/") })

export const dep = (target: Target, kind: DependencyKind = "static", specifier = ""): Dependency => ({
  target,
  kind,
  specifier,
  location: loc,
})

export const source = (path: string, dependencies: ReadonlyArray<Dependency> = [], rest: Partial<SourceFile> = {}): SourceFile => ({
  path: path.split("/"),
  dependencies,
  declarations: [],
  exports: [],
  uses: [],
  lines: 0,
  ...rest,
})

export const graph = (...files: ReadonlyArray<SourceFile>): Graph => ({ files })

export const edge = (from: string, dependency: Dependency): Edge => ({ source: from.split("/"), dependency })

export const filter = (transitive: boolean, kinds: EdgeFilter["kinds"] = ["static", "type", "require", "dynamic"]): EdgeFilter => ({
  kinds,
  localOnly: false,
  transitive,
})

/** Glob selecting `prefix/**`, or one literal path when `exact`. */
export const glob = (...segments: ReadonlyArray<string>): Selector => ({
  _tag: "Glob",
  tokens: segments.map((segment) =>
    segment === "**"
      ? { _tag: "Globstar" as const }
      : { _tag: "Segment" as const, tokens: Array.from(segment, (char) => (char === "*" ? { _tag: "Star" as const } : { _tag: "Literal" as const, char })) },
  ),
})

export const rule = (id: string, subject: Selector, assertion: Assertion<Selector>, severity: Severity = "error"): Rule => ({
  id,
  severity,
  subject,
  assertion,
})

export const path = (text: string): FilePath => text.split("/")
