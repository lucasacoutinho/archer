import { builtinModules } from "node:module"
import type { Target } from "../core/model.ts"
import { NODE_MODULES } from "./paths.ts"

const bareNodeBuiltins: ReadonlySet<string> = new Set(builtinModules.filter((name) => !name.startsWith("node:")))

const prefixed = (specifier: string, prefix: string): string | undefined =>
  specifier.startsWith(prefix) && specifier.length > prefix.length ? specifier.slice(prefix.length) : undefined

/**
 * `node:fs` and `fs` give `Builtin(node, "fs")`, `bun:test` gives
 * `Builtin(bun, "test")`. The prefix alone makes a built-in, as at runtime;
 * a bare name must be in Node's own list, so `node:test` is one and `test` is not.
 */
export const builtinTarget = (specifier: string): Target | undefined => {
  const node = prefixed(specifier, "node:")
  if (node !== undefined) {
    return { _tag: "Builtin", runtime: "node", name: node }
  }
  const bun = prefixed(specifier, "bun:")
  if (bun !== undefined) {
    return { _tag: "Builtin", runtime: "bun", name: bun }
  }
  return bareNodeBuiltins.has(specifier) ? { _tag: "Builtin", runtime: "node", name: specifier } : undefined
}

export interface PackageName {
  readonly name: string
  readonly subpath: ReadonlyArray<string>
}

const isBareSpecifier = (specifier: string): boolean => {
  const first = specifier[0]
  return (
    first !== undefined &&
    first !== "." &&
    first !== "/" &&
    first !== "#" &&
    first !== "~" &&
    !specifier.includes(":") &&
    !specifier.includes("\\")
  )
}

const splitPackage = (parts: ReadonlyArray<string>): PackageName | undefined => {
  const scoped = parts[0]?.startsWith("@") === true
  const nameParts = parts.slice(0, scoped ? 2 : 1)
  if (nameParts.length < (scoped ? 2 : 1) || nameParts.some((part) => part === "")) {
    return undefined
  }
  return { name: nameParts.join("/"), subpath: parts.slice(nameParts.length).filter((part) => part !== "") }
}

/** Scope-aware: `@scope/pkg/sub/path` is `@scope/pkg` with subpath `["sub", "path"]`. */
export const specifierPackage = (specifier: string): PackageName | undefined =>
  isBareSpecifier(specifier) ? splitPackage(specifier.split("/")) : undefined

/** The segment after the last `node_modules`, so nested and pnpm layouts both name the right package. */
export const installedPackage = (segments: ReadonlyArray<string>): PackageName | undefined => {
  const index = segments.lastIndexOf(NODE_MODULES)
  return index < 0 ? undefined : splitPackage(segments.slice(index + 1))
}

export const isInstalled = (segments: ReadonlyArray<string>): boolean => segments.includes(NODE_MODULES)

/** DefinitelyTyped names `@a/b` as `@types/a__b`. */
const runtimeName = (name: string): string => {
  const typed = prefixed(name, "@types/")
  if (typed === undefined) {
    return name
  }
  const separator = typed.indexOf("__")
  return separator < 0 ? typed : `@${typed.slice(0, separator)}/${typed.slice(separator + 2)}`
}

/**
 * The specifier names the package when it is a package specifier for the
 * package that was found: `picomatch` stays `picomatch` when the file is in
 * `@types/picomatch`, and `react/jsx-runtime` keeps its subpath. Otherwise the
 * file's own package decides, as for a path alias or a `#` import.
 */
export const packageTarget = (specifier: string, installed: PackageName | undefined): Target | undefined => {
  const written = specifierPackage(specifier)
  const found =
    installed === undefined || (written !== undefined && [installed.name, runtimeName(installed.name)].includes(written.name))
      ? (written ?? installed)
      : installed
  return found === undefined ? undefined : { _tag: "Package", name: found.name, subpath: found.subpath }
}

const sourceExtensions: ReadonlyArray<string> = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]

/** `.js` in a specifier names the `.ts` file next to it. */
const extensionSubstitutes: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  [".js", [".ts", ".tsx"]],
  [".jsx", [".tsx"]],
  [".mjs", [".mts"]],
  [".cjs", [".cts"]],
]

/** The files a relative `require` can mean, in lookup order. */
export const fileCandidates = (base: string): ReadonlyArray<string> => [
  base,
  ...extensionSubstitutes.flatMap(([from, to]) => (base.endsWith(from) ? to.map((ext) => base.slice(0, -from.length) + ext) : [])),
  ...sourceExtensions.map((ext) => base + ext),
  ...sourceExtensions.map((ext) => `${base}/index${ext}`),
]
