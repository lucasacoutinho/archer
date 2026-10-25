/**
 * Orders strings by UTF-16 code unit, never by locale: JavaScript's `<` on
 * strings. Every ordering in a Graph uses it, so two runs produce the same
 * bytes on every machine.
 */
export const compareCodeUnits = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

export const splitPath = (path: string): ReadonlyArray<string> =>
  path
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part !== "")

export const NODE_MODULES: string = "node_modules"

const declarationSuffixes: ReadonlyArray<string> = [".d.ts", ".d.mts", ".d.cts"]

/** `.d.ts`, `.d.mts`, `.d.cts`, and `.d.<ext>.ts` for an arbitrary extension, as TypeScript names them. */
export const isDeclarationFileName = (fileName: string): boolean => {
  if (declarationSuffixes.some((suffix) => fileName.endsWith(suffix))) {
    return true
  }
  if (!fileName.endsWith(".ts")) {
    return false
  }
  const withoutTs = fileName.slice(0, -".ts".length)
  const extensionStart = withoutTs.lastIndexOf(".")
  return extensionStart > 0 && withoutTs.slice(0, extensionStart).endsWith(".d")
}

export const isJsonFileName = (fileName: string): boolean => fileName.endsWith(".json")
