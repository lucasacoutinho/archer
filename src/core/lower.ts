/** Port of lean/Archer/Impl/Lower.lean. */
import { Match, Result } from "effect"
import {
  allowed,
  type Config,
  type ConfigError,
  type ConfigSelector,
  constrained,
  type Layer,
  layerEdges,
  layerRuleId,
  lookupLayer,
  type PublicApi,
  publicApiRuleId,
  referencedLayers,
  ruleIds,
} from "./config.ts"
import type { Selector } from "./model.ts"
import { mapAssertion, type Policy, type Rule, type RuleOf } from "./rule.ts"

/** The first element that occurs again later in the list. */
const firstDup = (items: ReadonlyArray<string>): string | undefined =>
  items.find((item, index) => items.includes(item, index + 1))

const firstUnknown = (names: ReadonlyArray<string>, refs: ReadonlyArray<string>): string | undefined =>
  refs.find((ref) => !names.includes(ref))

/** The first validation error, in the order: duplicate layer, unknown layer, duplicate rule id, empty policy. */
export const validate = (config: Config): ConfigError | undefined => {
  const names = config.layers.map((layer) => layer.name)
  const duplicateLayer = firstDup(names)
  if (duplicateLayer !== undefined) return { _tag: "DuplicateLayer", name: duplicateLayer }
  const unknown = firstUnknown(names, referencedLayers(config))
  if (unknown !== undefined) return { _tag: "UnknownLayer", name: unknown }
  const ids = ruleIds(config)
  const duplicateId = firstDup(ids)
  if (duplicateId !== undefined) return { _tag: "DuplicateRuleId", id: duplicateId }
  return ids.length === 0 ? { _tag: "EmptyPolicy" } : undefined
}

const nothing: Selector = { _tag: "Any", selectors: [] }

/** Substitute each `Layer n` by the selector of the first layer named `n`. */
export const resolve = (layers: ReadonlyArray<Layer>, selector: ConfigSelector): Selector =>
  Match.valueTags(selector, {
    Base: ({ selector: base }): Selector => base,
    Layer: ({ name }): Selector => lookupLayer(layers, name) ?? nothing,
    Any: ({ selectors }): Selector => ({ _tag: "Any", selectors: selectors.map((inner) => resolve(layers, inner)) }),
    All: ({ selectors }): Selector => ({ _tag: "All", selectors: selectors.map((inner) => resolve(layers, inner)) }),
    Not: ({ selector: inner }): Selector => ({ _tag: "Not", selector: resolve(layers, inner) }),
  })

const lowerRule = (layers: ReadonlyArray<Layer>, rule: RuleOf<ConfigSelector>): Rule => ({
  id: rule.id,
  severity: rule.severity,
  subject: resolve(layers, rule.subject),
  assertion: mapAssertion(rule.assertion, (selector) => resolve(layers, selector)),
})

/** Files of another layer that `name` may not depend on. */
const disallowed = (config: Config, name: string): Selector => ({
  _tag: "Any",
  selectors: config.layers
    .filter((layer) => layer.name !== name && !allowed(config, name).includes(layer.name))
    .map((layer) => layer.selector),
})

const layerRule = (config: Config, layer: Layer): Rule => ({
  id: layerRuleId(layer.name),
  severity: "error",
  subject: layer.selector,
  assertion: {
    _tag: "Reach",
    direction: "outgoing",
    relation: "forbid",
    object: { _tag: "All", selectors: [disallowed(config, layer.name), { _tag: "Not", selector: layer.selector }] },
    edges: layerEdges,
  },
})

const publicApiRule = (config: Config, api: PublicApi): Rule => {
  const layer = resolve(config.layers, { _tag: "Layer", name: api.layer })
  return {
    id: publicApiRuleId(api.layer),
    severity: "error",
    subject: { _tag: "Not", selector: layer },
    assertion: {
      _tag: "Reach",
      direction: "outgoing",
      relation: "forbid",
      object: { _tag: "All", selectors: [layer, { _tag: "Not", selector: api.entry }] },
      edges: layerEdges,
    },
  }
}

/** The policy of a valid configuration, in `ruleIds` order. */
export const build = (config: Config): Policy => [
  ...config.rules.map((rule) => lowerRule(config.layers, rule)),
  ...config.layers.filter((layer) => constrained(config, layer.name)).map((layer) => layerRule(config, layer)),
  ...config.publicApis.map((api) => publicApiRule(config, api)),
]

export const lower = (config: Config): Result.Result<Policy, ConfigError> => {
  const error = validate(config)
  return error === undefined ? Result.succeed(build(config)) : Result.fail(error)
}
