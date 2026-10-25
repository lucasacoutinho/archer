import type { ConfigSelector, Config } from "../../src/core/config.ts"
import type { Fingerprint } from "../../src/core/fingerprint.ts"
import type {
  Declaration,
  Dependency,
  DependencyKind,
  EdgeFilter,
  FilePath,
  Graph,
  PathToken,
  Selector,
  SourceFile,
  Target,
  Use,
} from "../../src/core/model.ts"
import type { Assertion, DeclarationPredicate, Rule, RuleOf, UseSpec } from "../../src/core/rule.ts"

export interface Random {
  readonly int: (bound: number) => number
  readonly pick: <A>(values: ReadonlyArray<A>) => A
  readonly chance: (probability: number) => boolean
  readonly some: <A>(values: ReadonlyArray<A>, max: number) => Array<A>
  readonly many: <A>(max: number, make: () => A) => Array<A>
}

/** mulberry32: deterministic, so a failing seed reproduces. */
export const random = (seed: number): Random => {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (bound: number) => Math.floor(next() * bound)
  const pick = <A>(values: ReadonlyArray<A>): A => values[int(values.length)] as A
  const many = <A>(max: number, make: () => A) => Array.from({ length: int(max + 1) }, make)
  return {
    int,
    pick,
    chance: (probability) => next() < probability,
    many,
    some: (values, max) => many(max, () => pick(values)),
  }
}

const folders = ["a", "b", "c"]
const names = ["x.ts", "y.ts", "z.ts"]
const kinds: ReadonlyArray<DependencyKind> = ["static", "type", "require", "dynamic"]
const words = ["eval", "useEffect", "inject", "Base", "Run", "execute", "default"]
const awkward = ["a|b", "c/d", "e\\f", "g\nh", "i\rj", "plain", "ü😀"]

const path = (rng: Random): FilePath => ["src", rng.pick(folders), rng.pick(names)]

const target = (rng: Random): Target =>
  rng.pick<() => Target>([
    () => ({ _tag: "File", path: path(rng) }),
    () => ({ _tag: "File", path: path(rng) }),
    () => ({ _tag: "Package", name: rng.pick(["react", "zod"]), subpath: rng.some(["jsx", "x"], 1) }),
    () => ({ _tag: "Builtin", runtime: rng.pick(["node", "bun"] as const), name: rng.pick(["fs", "test"]) }),
    () => ({ _tag: "Unresolved", specifier: rng.pick(["./missing", "@x/y"]) }),
    () => ({ _tag: "Computed" }),
  ])()

const location = (rng: Random) => ({ line: 1 + rng.int(3), column: 1 + rng.int(2) })

const dependency = (rng: Random): Dependency => ({
  target: target(rng),
  kind: rng.pick(kinds),
  specifier: rng.pick(["./x", "react", ""]),
  location: location(rng),
})

const declaration = (rng: Random): Declaration => ({
  name: rng.pick(words),
  kind: rng.pick(["class", "interface", "enum", "function", "type", "variable"] as const),
  exported: rng.chance(0.5),
  abstract: rng.chance(0.3),
  extended: rng.some(["Base"], 1),
  implemented: rng.some(["Run"], 1),
  decorators: rng.some(["Controller"], 1),
  methods: rng.many(2, () => ({
    name: rng.pick(["execute", "reset"]),
    visibility: rng.pick(["public", "protected", "private"] as const),
    isStatic: rng.chance(0.2),
  })),
  readonlyProperties: rng.chance(0.5),
  location: location(rng),
})

const use = (rng: Random): Use => ({
  kind: rng.pick(["call", "looseEquality"] as const),
  name: rng.pick(words),
  binding: rng.pick<Use["binding"]>([
    { _tag: "Global" },
    { _tag: "Local" },
    { _tag: "Imported", name: { source: rng.pick(["react", "vue"]), name: rng.pick(words) } },
  ]),
  location: location(rng),
})

const sourceFile = (rng: Random, filePath: FilePath): SourceFile => ({
  path: filePath,
  dependencies: rng.many(4, () => dependency(rng)),
  declarations: rng.many(2, () => declaration(rng)),
  exports: rng.some(words, 2),
  uses: rng.many(2, () => use(rng)),
  lines: rng.int(40),
})

export const graph = (rng: Random): Graph => {
  const paths = new Map<string, FilePath>()
  for (const candidate of rng.many(7, () => path(rng))) paths.set(candidate.join("/"), candidate)
  return { files: [...paths.values()].map((filePath) => sourceFile(rng, filePath)) }
}

const pathPattern = (rng: Random): Array<PathToken> => {
  const literal = (text: string): PathToken => ({
    _tag: "Segment",
    tokens: Array.from(text, (char) => ({ _tag: "Literal", char })),
  })
  return rng.pick<() => Array<PathToken>>([
    () => [literal("src"), { _tag: "Globstar" }],
    () => [literal("src"), literal(rng.pick(folders)), { _tag: "Globstar" }],
    () => [{ _tag: "Globstar" }, { _tag: "Segment", tokens: [{ _tag: "One" }, { _tag: "Star" }, ...Array.from(".ts", (char) => ({ _tag: "Literal" as const, char }))] }],
    () => [literal("src"), { _tag: "Segment", tokens: [{ _tag: "Star" }] }, literal(rng.pick(names))],
  ])()
}

export const selector = (rng: Random, depth = 2): Selector =>
  rng.pick<() => Selector>([
    () => ({ _tag: "Glob", tokens: pathPattern(rng) }),
    () => ({ _tag: "Glob", tokens: pathPattern(rng) }),
    () => (rng.chance(0.5) ? { _tag: "Package" } : { _tag: "Package", name: rng.pick(["react", "zod"]) }),
    () => ({ _tag: "Builtin", runtime: "node" }),
    () => ({ _tag: "Unresolved" }),
    () => ({ _tag: "Computed" }),
    () => (depth > 0 ? { _tag: "Not", selector: selector(rng, depth - 1) } : { _tag: "Computed" }),
    () => (depth > 0 ? { _tag: "Any", selectors: rng.many(2, () => selector(rng, depth - 1)) } : { _tag: "Unresolved" }),
    () => (depth > 0 ? { _tag: "All", selectors: rng.many(2, () => selector(rng, depth - 1)) } : { _tag: "Unresolved" }),
  ])()

export const edgeFilter = (rng: Random): EdgeFilter => ({
  kinds: rng.chance(0.5) ? [...kinds] : [rng.pick(kinds)],
  localOnly: rng.chance(0.3),
  transitive: rng.chance(0.5),
})

const predicate = (rng: Random, depth = 1): DeclarationPredicate =>
  rng.pick<() => DeclarationPredicate>([
    () => ({ _tag: "Kind", kinds: rng.some(["class", "function", "type"] as const, 2) }),
    () => ({ _tag: "Abstract" }),
    () => ({ _tag: "Exported" }),
    () => ({ _tag: "ReadonlyProperties" }),
    () => ({ _tag: "Extends", name: "Base" }),
    () => ({ _tag: "Implements", name: "Run" }),
    () => ({ _tag: "Decorator", name: "Controller" }),
    () =>
      rng.chance(0.5)
        ? { _tag: "HasMethods", names: rng.some(["execute", "reset"], 2) }
        : { _tag: "HasMethods", names: ["execute"], visibility: rng.pick(["public", "private"] as const) },
    () => ({ _tag: "OnlyPublicMethods" }),
    () => (depth > 0 ? { _tag: "All", predicates: rng.many(2, () => predicate(rng, depth - 1)) } : { _tag: "Exported" }),
  ])()

const useSpec = (rng: Random): UseSpec =>
  rng.pick<() => UseSpec>([
    () => ({ _tag: "LooseEquality" }),
    () => ({ _tag: "Globals", names: rng.some(words, 2) }),
    () => ({ _tag: "Imported", source: rng.pick(["react", "vue"]), names: rng.some(words, 2) }),
  ])()

const assertion = <S>(rng: Random, object: () => S): Assertion<S> =>
  rng.pick<() => Assertion<S>>([
    () => ({
      _tag: "Reach",
      direction: rng.pick(["outgoing", "incoming"] as const),
      relation: rng.pick(["forbid", "require"] as const),
      object: object(),
      edges: edgeFilter(rng),
    }),
    () => ({
      _tag: "Reach",
      direction: rng.pick(["outgoing", "incoming"] as const),
      relation: rng.pick(["forbid", "require"] as const),
      object: object(),
      edges: edgeFilter(rng),
    }),
    () => (rng.chance(0.5) ? { _tag: "Acyclic", edges: edgeFilter(rng) } : { _tag: "Acyclic", edges: edgeFilter(rng), folderDepth: rng.int(3) }),
    () => ({ _tag: "Resolvable", allowComputed: rng.chance(0.5) }),
    () => ({ _tag: "Declares", quantifier: rng.pick(["every", "none"] as const), predicate: predicate(rng) }),
    () => ({ _tag: "ExportsOnly", names: rng.some(words, 3) }),
    () => ({ _tag: "Uses", relation: rng.pick(["forbid", "require"] as const), use: useSpec(rng) }),
    () => ({ _tag: "Named", relation: rng.pick(["forbid", "require"] as const), affix: rng.pick(["prefix", "suffix"] as const), value: rng.pick(["x", ".ts", "z."]) }),
    () => ({ _tag: "MaxLines", max: 1 + rng.int(30) }),
    () => ({ _tag: "Custom", name: rng.pick(["c1", "c2"]) }),
  ])()

const severity = (rng: Random) => rng.pick(["error", "warning", "info"] as const)

export const policy = (rng: Random): Array<Rule> =>
  rng.many(4, () => ({
    id: `r${rng.int(5)}`,
    severity: severity(rng),
    subject: selector(rng),
    assertion: assertion(rng, () => selector(rng)),
  }))

export interface CustomResult {
  readonly name: string
  readonly subject: FilePath
  readonly messages: ReadonlyArray<string>
}

export const customResults = (rng: Random, input: Graph): Array<CustomResult> =>
  input.files.flatMap((file) =>
    rng.chance(0.4) ? [{ name: rng.pick(["c1", "c2"]), subject: file.path, messages: rng.some(["m", "n"], 2) }] : [],
  )

const layerNames = ["ui", "app", "domain", "infra"]

export const configSelector = (rng: Random, depth = 1): ConfigSelector =>
  rng.pick<() => ConfigSelector>([
    () => ({ _tag: "Base", selector: selector(rng, 1) }),
    () => ({ _tag: "Layer", name: rng.pick([...layerNames, "ghost"]) }),
    () => (depth > 0 ? { _tag: "Not", selector: configSelector(rng, depth - 1) } : { _tag: "Layer", name: "app" }),
    () => (depth > 0 ? { _tag: "Any", selectors: rng.many(2, () => configSelector(rng, depth - 1)) } : { _tag: "Layer", name: "ui" }),
  ])()

export const config = (rng: Random): Config => {
  const layers = rng.some(layerNames, 4).map((name) => ({ name, selector: selector(rng, 1) }))
  const known = layers.map((layer) => layer.name)
  const name = () => (rng.chance(0.9) && known.length > 0 ? rng.pick(known) : rng.pick(layerNames))
  return {
    layers,
    stack: rng.many(3, name),
    allow: rng.many(2, () => [name(), rng.many(2, name)] as const),
    publicApis: rng.many(1, () => ({ layer: name(), entry: selector(rng, 0) })),
    rules: rng.many(2, (): RuleOf<ConfigSelector> => ({
      id: rng.pick(["user", "other", "layer/ui"]),
      severity: severity(rng),
      subject: configSelector(rng),
      assertion: assertion(rng, () => configSelector(rng)),
    })),
  }
}

export const awkwardFingerprint = (rng: Random): Fingerprint => ({
  ruleId: rng.pick(awkward),
  subject: rng.some(awkward.filter((text) => !text.includes("/")), 2),
  key: rng.pick<Fingerprint["key"]>([
    { _tag: "Custom", message: rng.pick(awkward) },
    { _tag: "Declaration", name: rng.pick(awkward) },
    { _tag: "Dependency", target: { _tag: "Unresolved", specifier: rng.pick(awkward) }, specifier: rng.pick(awkward), kind: "dynamic" },
    { _tag: "Use", kind: "call", name: rng.pick(awkward), binding: { _tag: "Imported", name: { source: rng.pick(awkward), name: "n" } } },
    { _tag: "Missing" },
  ]),
})

const validSegments = ["src", "a", "b", "domain", "*", "?", "**", "*.ts", "a?", "x*y", "***", "😀", "ü😀*", ".hidden", "...", "@s", "npm:x", "node:fs", "layer:y"]
const invalidSegments = [".", "..", ""]
const unsupportedSegments = ["a\\b", "[a]", "]", "\\"]
const prefixedTexts = [
  "npm:*", "npm:react", "npm:zod", "npm:@s/x", "npm:@s", "npm:@", "npm:@/x", "npm:@s/", "npm:@s/x/y", "npm:a/b", "npm:/a", "npm:a/", "npm:", "npm:**", "npm:a*", "npm:😀",
  "node:*", "node:fs", "node:fs/promises", "node:**", "node:", "node:a/b/", "bun:*", "bun:test", "bun:", "bun:😀",
  "layer:app", "layer:ui", "layer:", "layer:*", "layer:a/b", "layer:😀",
  "unresolved:*", "unresolved:*", "unresolved:x", "unresolved:", "unresolved:**",
  "computed:*", "computed:*", "computed:x", "computed:", "computed:*/",
]
const nameFragments = ["react", "zod", "@s/x", "fs", "test", "*", "app", "", "a/b", "😀"]
const specialCharacters = ["{", "}", ",", "\\", "[", "]", "/", ".", "*", "?", ":", "😀"]

const textGlob = (rng: Random): string => {
  const segments = Array.from({ length: 1 + rng.int(3) }, () =>
    rng.chance(0.06) ? rng.pick(invalidSegments) : rng.chance(0.04) ? rng.pick(unsupportedSegments) : rng.pick(validSegments),
  )
  return rng.pick(["", "", "", "", "./", "./", "/"]) + segments.join("/") + (rng.chance(0.04) ? "/" : "")
}

const textFragment = (rng: Random, depth: number): string =>
  rng.pick<() => string>([
    () => textGlob(rng),
    () => rng.pick(prefixedTexts),
    () => rng.pick(nameFragments),
    () => (depth > 0 ? textGroup(rng, depth - 1) : textGlob(rng)),
  ])()

const textGroup = (rng: Random, depth: number): string => {
  const alternatives = Array.from({ length: 1 + rng.int(3) }, () => textFragment(rng, depth))
  return `${rng.pick(["", "", "src/", "./", "npm:", "node:", "x", ","])}{${alternatives.join(",")}}${rng.pick(["", "", "/**", "/x", "{a,b}", "}"])}`
}

/** Selector strings for parse and print: about half are valid, the rest fail in every way parse can reject. */
export const selectorText = (rng: Random): string => {
  const generated = rng.pick<() => string>([
    () => textGlob(rng),
    () => textGlob(rng),
    () => textGlob(rng),
    () => rng.pick(prefixedTexts),
    () => rng.pick(prefixedTexts),
    () => textGroup(rng, 2),
    () => textGroup(rng, 2),
    () => textGroup(rng, 2),
  ])()
  if (rng.chance(0.01)) return ""
  if (!rng.chance(0.25)) return generated
  const characters = Array.from(generated)
  const at = rng.int(characters.length + 1)
  return rng.pick<() => string>([
    () => characters.slice(0, at).join(""),
    () => [...characters.slice(0, at), rng.pick(specialCharacters), ...characters.slice(at)].join(""),
    () => [...characters.slice(0, at), ...characters.slice(at + 1)].join(""),
  ])()
}
