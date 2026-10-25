/** Schemas and definitions of lean/Archer/Config.lean. */
import { Match, Schema } from "effect"
import { type EdgeFilter, Selector } from "./model.ts"
import { assertionSelectors, ruleOf, type RuleOf } from "./rule.ts"

/** A selector that can also refer to a layer by name (`layer:domain`). */
export type ConfigSelector =
  | { readonly _tag: "Base"; readonly selector: Selector }
  | { readonly _tag: "Layer"; readonly name: string }
  | { readonly _tag: "Any"; readonly selectors: ReadonlyArray<ConfigSelector> }
  | { readonly _tag: "All"; readonly selectors: ReadonlyArray<ConfigSelector> }
  | { readonly _tag: "Not"; readonly selector: ConfigSelector }

export const ConfigSelector: Schema.Codec<ConfigSelector> = Schema.Union([
  Schema.TaggedStruct("Base", { selector: Selector }),
  Schema.TaggedStruct("Layer", { name: Schema.String }),
  Schema.TaggedStruct("Any", {
    selectors: Schema.Array(Schema.suspend((): Schema.Codec<ConfigSelector> => ConfigSelector)),
  }),
  Schema.TaggedStruct("All", {
    selectors: Schema.Array(Schema.suspend((): Schema.Codec<ConfigSelector> => ConfigSelector)),
  }),
  Schema.TaggedStruct("Not", { selector: Schema.suspend((): Schema.Codec<ConfigSelector> => ConfigSelector) }),
])

export const layerNames = (selector: ConfigSelector): Array<string> =>
  Match.valueTags(selector, {
    Base: () => [],
    Layer: ({ name }) => [name],
    Any: ({ selectors }) => selectors.flatMap(layerNames),
    All: ({ selectors }) => selectors.flatMap(layerNames),
    Not: ({ selector: inner }) => layerNames(inner),
  })

export interface Layer {
  readonly name: string
  readonly selector: Selector
}

export const Layer: Schema.Codec<Layer> = Schema.Struct({ name: Schema.String, selector: Selector })

/** Lean `lookupLayer`: the first layer with that name. */
export const lookupLayer = (layers: ReadonlyArray<Layer>, name: string): Selector | undefined =>
  layers.find((layer) => layer.name === name)?.selector

export interface PublicApi {
  readonly layer: string
  /** The files of the layer that other layers may import. */
  readonly entry: Selector
}

export const PublicApi: Schema.Codec<PublicApi> = Schema.Struct({
  layer: Schema.String,
  /** The files of the layer that other layers may import. */
  entry: Selector,
})

export interface Config {
  readonly layers: ReadonlyArray<Layer>
  /** Top to bottom: each layer may depend on the layers listed after it. */
  readonly stack: ReadonlyArray<string>
  /** Further layers each layer may depend on. */
  readonly allow: ReadonlyArray<readonly [string, ReadonlyArray<string>]>
  readonly publicApis: ReadonlyArray<PublicApi>
  readonly rules: ReadonlyArray<RuleOf<ConfigSelector>>
}

export const Config: Schema.Codec<Config> = Schema.Struct({
  layers: Schema.Array(Layer),
  stack: Schema.Array(Schema.String),
  allow: Schema.Array(Schema.Tuple([Schema.String, Schema.Array(Schema.String)])),
  publicApis: Schema.Array(PublicApi),
  rules: Schema.Array(ruleOf(ConfigSelector)),
})

export type ConfigError =
  | { readonly _tag: "DuplicateLayer"; readonly name: string }
  | { readonly _tag: "UnknownLayer"; readonly name: string }
  | { readonly _tag: "DuplicateRuleId"; readonly id: string }
  | { readonly _tag: "EmptyPolicy" }

export const ConfigError: Schema.Codec<ConfigError> = Schema.Union([
  Schema.TaggedStruct("DuplicateLayer", { name: Schema.String }),
  Schema.TaggedStruct("UnknownLayer", { name: Schema.String }),
  Schema.TaggedStruct("DuplicateRuleId", { id: Schema.String }),
  Schema.TaggedStruct("EmptyPolicy", {}),
])

/** A layer is constrained when the stack or the allow table mentions it as the depending layer. */
export const constrained = (config: Config, name: string): boolean =>
  config.stack.includes(name) || config.allow.some(([from]) => from === name)

/** The layers a constrained layer may depend on, besides itself. */
export const allowed = (config: Config, name: string): Array<string> => {
  const index = config.stack.indexOf(name)
  return [
    ...(index < 0 ? [] : config.stack.slice(index + 1)),
    ...config.allow.filter(([from]) => from === name).flatMap(([, to]) => to),
  ]
}

/** Direct dependencies on source files, of every kind. */
export const layerEdges: EdgeFilter = {
  kinds: ["static", "type", "require", "dynamic"],
  localOnly: true,
  transitive: false,
}

export const layerRuleId = (name: string): string => `layer/${name}`

export const publicApiRuleId = (name: string): string => `public-api/${name}`

/** Every layer name the configuration refers to. */
export const referencedLayers = (config: Config): Array<string> => [
  ...config.stack,
  ...config.allow.flatMap(([name, names]) => [name, ...names]),
  ...config.publicApis.map((api) => api.layer),
  ...config.rules.flatMap((rule) => [
    ...layerNames(rule.subject),
    ...assertionSelectors(rule.assertion).flatMap(layerNames),
  ]),
]

/** The rule IDs the lowered policy has. */
export const ruleIds = (config: Config): Array<string> => [
  ...config.rules.map((rule) => rule.id),
  ...config.layers.filter((layer) => constrained(config, layer.name)).map((layer) => layerRuleId(layer.name)),
  ...config.publicApis.map((api) => publicApiRuleId(api.layer)),
]
