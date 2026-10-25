/**
 * Port of `Archer.Pattern.accepts` (lean/Archer/Pattern.lean), specialized to
 * strings: code points for segments, segments for paths. Correspondence is
 * obligation T1 in docs/verification.md.
 */

import { Match } from "effect"

export type Token =
  | { readonly _tag: "Sat"; readonly test: (value: string) => boolean }
  | { readonly _tag: "Many" }

const acceptsFrom = (
  pattern: ReadonlyArray<Token>,
  patternIndex: number,
  list: ReadonlyArray<string>,
  listIndex: number,
): boolean => {
  const token = pattern[patternIndex]
  if (token === undefined) {
    return listIndex === list.length
  }
  return Match.valueTags(token, {
    Sat: ({ test }) => {
      const value = list[listIndex]
      return value !== undefined && test(value) && acceptsFrom(pattern, patternIndex + 1, list, listIndex + 1)
    },
    // Lean `anySuffix`: suffixes from the longest
    Many: () => {
      for (let suffix = listIndex; suffix <= list.length; suffix++) {
        if (acceptsFrom(pattern, patternIndex + 1, list, suffix)) {
          return true
        }
      }
      return false
    },
  })
}

export const accepts = (pattern: ReadonlyArray<Token>, list: ReadonlyArray<string>): boolean =>
  acceptsFrom(pattern, 0, list, 0)
