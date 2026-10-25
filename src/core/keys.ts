import { Match } from "effect"
import type { EdgeFilter, FilePath, Target } from "./model.ts"

/**
 * Keys that are equal exactly when the values are structurally equal, like
 * `structuralKey`, but without its key-sorting replacer: the hot loops of the
 * check compare paths and targets many times per edge.
 */
export const pathKey = (path: FilePath): string => JSON.stringify(path)

export const targetKey = (target: Target): string =>
  Match.valueTags(target, {
    File: ({ path }): string => `F${JSON.stringify(path)}`,
    Package: ({ name, subpath }): string => `P${JSON.stringify([name, subpath])}`,
    Builtin: ({ runtime, name }): string => `B${JSON.stringify([runtime, name])}`,
    Unresolved: ({ specifier }): string => `U${JSON.stringify(specifier)}`,
    Computed: (): string => "C",
  })

export const filterKey = (filter: EdgeFilter): string =>
  JSON.stringify([filter.kinds, filter.localOnly, filter.transitive])
