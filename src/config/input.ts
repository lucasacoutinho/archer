import { Match, Result, Schema } from "effect"
import type { Config, ConfigSelector, Layer, PublicApi } from "../core/config.ts"
import type { Selector } from "../core/model.ts"
import { type Assertion, assertionOf, mapAssertion, type RuleOf, Severity } from "../core/rule.ts"
import { parse } from "../core/text.ts"
import type { RuleInfo } from "../report/report.ts"
import type { CustomCheck, CustomContext, RuleSpec, SelectorInput } from "./rules.ts"

/** Integer-like keys enumerate before the others in JavaScript, which would reorder layers. */
const isArrayIndex = (name: string): boolean => {
  const value = Number(name)
  return Number.isInteger(value) && value >= 0 && String(value) === name
}

const LayerName: Schema.NonEmptyString = Schema.NonEmptyString

const SelectorShape: Schema.Codec<SelectorInput> = Schema.Union([
  Schema.String,
  Schema.Array(Schema.suspend((): Schema.Codec<SelectorInput> => SelectorShape)),
  Schema.Struct({ not: Schema.suspend((): Schema.Codec<SelectorInput> => SelectorShape) }),
  Schema.Struct({ all: Schema.Array(Schema.suspend((): Schema.Codec<SelectorInput> => SelectorShape)) }),
])

interface RuleShape {
  readonly id: string
  readonly severity?: Severity
  readonly reason?: string
  readonly subject: SelectorInput
  readonly assertion: Assertion<SelectorInput>
  readonly check?: unknown
}

const RuleShape: Schema.Codec<RuleShape> = Schema.Struct({
  id: Schema.NonEmptyString,
  severity: Schema.optionalKey(Severity),
  reason: Schema.optionalKey(Schema.String),
  subject: SelectorShape,
  assertion: assertionOf(SelectorShape),
  check: Schema.optionalKey(Schema.Unknown),
})

interface ArcherShape {
  readonly root?: string
  readonly projects?: readonly [string, ...Array<string>]
  readonly layers?: Readonly<Record<string, SelectorInput>>
  readonly stack?: ReadonlyArray<string>
  readonly allow?: Readonly<Record<string, ReadonlyArray<string>>>
  readonly publicApis?: Readonly<Record<string, SelectorInput>>
  readonly rules?: ReadonlyArray<RuleShape>
  readonly baseline?: string | false
  readonly failOnWarnings?: boolean
}

export const ArcherConfig: Schema.Codec<ArcherShape> = Schema.Struct({
  /** Relative to the configuration file. */
  root: Schema.optionalKey(Schema.String),
  /** tsconfig files, relative to `root`. */
  projects: Schema.optionalKey(Schema.NonEmptyArray(Schema.NonEmptyString)),
  layers: Schema.optionalKey(Schema.Record(LayerName, SelectorShape)),
  stack: Schema.optionalKey(Schema.Array(LayerName)),
  allow: Schema.optionalKey(Schema.Record(LayerName, Schema.Array(LayerName))),
  publicApis: Schema.optionalKey(Schema.Record(LayerName, SelectorShape)),
  rules: Schema.optionalKey(Schema.Array(RuleShape)),
  /** Relative to `root`; `false` checks without a baseline. */
  baseline: Schema.optionalKey(Schema.Union([Schema.String, Schema.Literal(false)])),
  failOnWarnings: Schema.optionalKey(Schema.Boolean),
}).check(
  Schema.makeFilter((config) => {
    const names = [config.layers, config.allow, config.publicApis].flatMap((table) => Object.keys(table ?? {}))
    const index = names.find(isArrayIndex)
    return index === undefined || `layer name '${index}' must not look like an array index`
  }),
)

/** What a configuration file exports. `defineConfig` only adds type inference. */
export interface ArcherConfig {
  readonly root?: string
  readonly projects?: readonly [string, ...Array<string>]
  readonly layers?: Readonly<Record<string, SelectorInput>>
  readonly stack?: ReadonlyArray<string>
  readonly allow?: Readonly<Record<string, ReadonlyArray<string>>>
  readonly publicApis?: Readonly<Record<string, SelectorInput>>
  readonly rules?: ReadonlyArray<RuleSpec>
  readonly baseline?: string | false
  readonly failOnWarnings?: boolean
}

export const defineConfig = (config: ArcherConfig): ArcherConfig => config

/** A decoded configuration: the Lean `Config` plus what only the shell needs. */
export interface Configuration {
  readonly config: Config
  readonly custom: ReadonlyMap<string, CustomCheck>
  readonly rules: ReadonlyArray<RuleInfo>
  readonly root: string
  readonly projects: readonly [string, ...Array<string>]
  readonly baseline: string | undefined
  readonly failOnWarnings: boolean
}

export class ConfigInvalid extends Schema.TaggedError<ConfigInvalid, { readonly brand: unique symbol }>()(
  "ConfigInvalid",
  { issues: Schema.NonEmptyArray(Schema.String) },
) {}

type Converted<A> = Result.Result<A, ReadonlyArray<string>>

const all = <A>(items: ReadonlyArray<Converted<A>>): Converted<Array<A>> => {
  const issues = items.flatMap((item) => (Result.isFailure(item) ? item.failure : []))
  return issues.length > 0 ? Result.fail(issues) : Result.succeed(items.flatMap((item) => (Result.isSuccess(item) ? [item.success] : [])))
}

const isList = (input: SelectorInput): input is ReadonlyArray<SelectorInput> => Array.isArray(input)

const toConfigSelector = (input: SelectorInput, at: string): Converted<ConfigSelector> =>
  Match.value(input).pipe(
    Match.when(Match.string, (text): Converted<ConfigSelector> =>
      Result.mapError(parse(text), (error) => [`${at}: '${text}' is not a selector (${error._tag})`]),
    ),
    Match.when(isList, (items) =>
      Result.map(
        all(items.map((item, index) => toConfigSelector(item, `${at}[${index}]`))),
        (selectors): ConfigSelector => (selectors.length === 1 && selectors[0] !== undefined ? selectors[0] : { _tag: "Any", selectors }),
      ),
    ),
    Match.when({ not: Match.defined }, ({ not }) =>
      Result.map(toConfigSelector(not, `${at}.not`), (selector): ConfigSelector => ({ _tag: "Not", selector })),
    ),
    Match.orElse(({ all: items }) =>
      Result.map(
        all(items.map((item, index) => toConfigSelector(item, `${at}.all[${index}]`))),
        (selectors): ConfigSelector => ({ _tag: "All", selectors }),
      ),
    ),
  )

/** Layer and entry selectors define layers, so they cannot refer to one. */
const withoutLayers = (selector: ConfigSelector, at: string): Converted<Selector> =>
  Match.valueTags(selector, {
    Base: ({ selector: base }): Converted<Selector> => Result.succeed(base),
    Layer: ({ name }): Converted<Selector> => Result.fail([`${at}: 'layer:${name}' cannot be used to define a layer`]),
    Any: ({ selectors }) =>
      Result.map(all(selectors.map((inner) => withoutLayers(inner, at))), (inner): Selector => ({ _tag: "Any", selectors: inner })),
    All: ({ selectors }) =>
      Result.map(all(selectors.map((inner) => withoutLayers(inner, at))), (inner): Selector => ({ _tag: "All", selectors: inner })),
    Not: ({ selector: inner }) => Result.map(withoutLayers(inner, at), (base): Selector => ({ _tag: "Not", selector: base })),
  })

const layerSelector = (input: SelectorInput, at: string): Converted<Selector> =>
  Result.flatMap(toConfigSelector(input, at), (selector) => withoutLayers(selector, at))

const convertRule = (rule: RuleShape, at: string): Converted<RuleOf<ConfigSelector>> => {
  const selectors: Array<Converted<ConfigSelector>> = []
  const assertion = mapAssertion(rule.assertion, (input) => {
    const converted = toConfigSelector(input, `${at}.assertion`)
    selectors.push(converted)
    return Result.getOrElse(converted, (): ConfigSelector => ({ _tag: "Any", selectors: [] }))
  })
  const custom =
    rule.assertion._tag === "Custom" && typeof rule.check !== "function"
      ? [Result.fail([`${at}: a custom rule needs a check function`])]
      : []
  return Result.flatMap(all([toConfigSelector(rule.subject, `${at}.subject`), ...selectors, ...custom]), ([subject]) =>
    subject === undefined
      ? Result.fail([`${at}.subject: missing`])
      : Result.succeed({ id: rule.id, severity: rule.severity ?? "error", subject, assertion }),
  )
}

const Messages: Schema.Codec<ReadonlyArray<string>> = Schema.Array(Schema.String)

/** A user check is untrusted: a throw or a malformed result becomes one finding, so the check stays total. */
const guarded =
  (check: Function): CustomCheck =>
  (context: CustomContext): ReadonlyArray<string> => {
    try {
      const output: unknown = Reflect.apply(check, undefined, [context])
      return Result.getOrElse(Schema.decodeUnknownResult(Messages)(output), () => [
        "custom rule returned something other than a list of messages",
      ])
    } catch (error) {
      return [`custom rule crashed: ${error instanceof Error ? error.message : String(error)}`]
    }
  }

const issuesOf = <A>(item: Converted<A>): ReadonlyArray<string> => (Result.isFailure(item) ? item.failure : [])

const allOf = <A, B, C>(
  a: Converted<A>,
  b: Converted<B>,
  c: Converted<C>,
): Converted<readonly [A, B, C]> =>
  Result.isSuccess(a) && Result.isSuccess(b) && Result.isSuccess(c)
    ? Result.succeed([a.success, b.success, c.success])
    : Result.fail([...issuesOf(a), ...issuesOf(b), ...issuesOf(c)])

export const decodeConfiguration = (input: unknown): Result.Result<Configuration, ConfigInvalid> => {
  const shaped = Schema.decodeUnknownResult(ArcherConfig, { errors: "all" })(input)
  if (Result.isFailure(shaped)) {
    return Result.fail(new ConfigInvalid({ issues: [shaped.failure.message] }))
  }
  const config = shaped.success
  const parts = allOf(
    all(
      Object.entries(config.layers ?? {}).map(([name, selector]) =>
        Result.map(layerSelector(selector, `layers.${name}`), (converted): Layer => ({ name, selector: converted })),
      ),
    ),
    all(
      Object.entries(config.publicApis ?? {}).map(([layer, entry]) =>
        Result.map(layerSelector(entry, `publicApis.${layer}`), (converted): PublicApi => ({ layer, entry: converted })),
      ),
    ),
    all((config.rules ?? []).map((rule, index) => convertRule(rule, `rules[${index}]`))),
  )
  return Result.mapBoth(parts, {
    onFailure: ([first = "invalid configuration", ...rest]) => new ConfigInvalid({ issues: [first, ...rest] }),
    onSuccess: ([layers, publicApis, rules]): Configuration => ({
      config: { layers, stack: config.stack ?? [], allow: Object.entries(config.allow ?? {}), publicApis, rules },
      custom: new Map(
        (config.rules ?? []).flatMap((rule) => (typeof rule.check === "function" ? [[rule.id, guarded(rule.check)] as const] : [])),
      ),
      rules: (config.rules ?? []).map((rule) => ({
        id: rule.id,
        severity: rule.severity ?? "error",
        ...(rule.reason === undefined ? {} : { reason: rule.reason }),
      })),
      root: config.root ?? ".",
      projects: config.projects ?? ["tsconfig.json"],
      baseline: config.baseline === false ? undefined : (config.baseline ?? ".archer-baseline"),
      failOnWarnings: config.failOnWarnings ?? false,
    }),
  })
}
