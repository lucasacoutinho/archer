/**
 * Lean derives `DecidableEq` structurally. Values here are plain JSON data,
 * so equality is equality of canonical JSON: object keys sorted, array order
 * kept, optional fields absent rather than `undefined`.
 */

const sortKeys = (_key: string, value: unknown): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : value

export const structuralKey = (value: unknown): string => JSON.stringify(value, sortKeys)

export const structuralEquals = (a: unknown, b: unknown): boolean => structuralKey(a) === structuralKey(b)

/** Lean `List.eraseDups` and `Baseline.dedup`: first occurrences, in order. */
export const dedupStructural = <A>(items: ReadonlyArray<A>): Array<A> => {
  const seen = new Set<string>()
  const kept: Array<A> = []
  for (const item of items) {
    const key = structuralKey(item)
    if (!seen.has(key)) {
      seen.add(key)
      kept.push(item)
    }
  }
  return kept
}
