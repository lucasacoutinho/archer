/** Port of `Archer.Selector.selects` and the token denotations in lean/Archer/Model.lean. */
import { Match } from "effect"
import type { FilePath, Graph, PathToken, SegmentToken, Selector, SourceFile, Target } from "./model.ts"
import { accepts, type Token } from "./pattern.ts"

const segmentDenote = (token: SegmentToken): Token =>
  Match.valueTags(token, {
    Literal: ({ char }): Token => ({ _tag: "Sat", test: (value) => value === char }),
    One: (): Token => ({ _tag: "Sat", test: () => true }),
    Star: (): Token => ({ _tag: "Many" }),
  })

/** Matches by code point, as Lean's `String.toList`, not by UTF-16 unit. */
export const segmentAccepts = (tokens: ReadonlyArray<SegmentToken>, segment: string): boolean =>
  accepts(tokens.map(segmentDenote), Array.from(segment))

const pathDenote = (token: PathToken): Token =>
  Match.valueTags(token, {
    Segment: ({ tokens }): Token => ({ _tag: "Sat", test: (segment) => segmentAccepts(tokens, segment) }),
    Globstar: (): Token => ({ _tag: "Many" }),
  })

export const pathAccepts = (tokens: ReadonlyArray<PathToken>, path: FilePath): boolean =>
  accepts(tokens.map(pathDenote), path)

export const selects = (selector: Selector, target: Target): boolean =>
  Match.valueTags(selector, {
    Glob: ({ tokens }) => target._tag === "File" && pathAccepts(tokens, target.path),
    Package: ({ name }) => target._tag === "Package" && (name === undefined || name === target.name),
    Builtin: ({ runtime, name }) =>
      target._tag === "Builtin" && runtime === target.runtime && (name === undefined || name === target.name),
    Unresolved: () => target._tag === "Unresolved",
    Computed: () => target._tag === "Computed",
    Any: ({ selectors }) => selectors.some((inner) => selects(inner, target)),
    All: ({ selectors }) => selectors.every((inner) => selects(inner, target)),
    Not: ({ selector: inner }) => !selects(inner, target),
  })

export const subjects = (graph: Graph, selector: Selector): Array<SourceFile> =>
  graph.files.filter((file) => selects(selector, { _tag: "File", path: file.path }))
