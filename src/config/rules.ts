import type { DeclarationKind, DependencyKind, Graph, Visibility } from "../core/model.ts"
import type { Assertion, DeclarationPredicate, Severity, UseSpec } from "../core/rule.ts"

/** Selector text, a union (array), or a combination. */
export type SelectorInput =
  | string
  | ReadonlyArray<SelectorInput>
  | { readonly not: SelectorInput }
  | { readonly all: ReadonlyArray<SelectorInput> }

export interface RuleOptions {
  readonly severity?: Severity
  readonly reason?: string
}

export interface EdgeOptions extends RuleOptions {
  readonly kinds?: ReadonlyArray<DependencyKind>
  readonly transitive?: boolean
  readonly localOnly?: boolean
}

export interface CustomContext {
  readonly graph: Graph
  /** The subject's root-relative path, `/`-separated. */
  readonly subject: string
}

export type CustomCheck = (context: CustomContext) => ReadonlyArray<string>

export interface RuleSpec {
  readonly id: string
  readonly severity?: Severity
  readonly reason?: string
  readonly subject: SelectorInput
  readonly assertion: Assertion<SelectorInput>
  /** The closure of a custom rule, whose assertion names it by the rule's ID. */
  readonly check?: CustomCheck
}

const allKinds: ReadonlyArray<DependencyKind> = ["static", "type", "require", "dynamic"]

interface Meta {
  readonly severity?: Severity
  readonly reason?: string
}

interface Edges {
  readonly kinds: ReadonlyArray<DependencyKind>
  readonly localOnly: boolean
  readonly transitive: boolean
}

export type ReachRule = (id: string, subject: SelectorInput, object: SelectorInput, options?: EdgeOptions) => RuleSpec

export type AcyclicRule = (
  id: string,
  subject: SelectorInput,
  options?: EdgeOptions & { readonly folderDepth?: number },
) => RuleSpec

export type ResolvableRule = (
  id: string,
  subject: SelectorInput,
  options?: RuleOptions & { readonly allowComputed?: boolean },
) => RuleSpec

export type DeclaresRule = (
  id: string,
  subject: SelectorInput,
  predicate: DeclarationPredicate,
  options?: RuleOptions,
) => RuleSpec

export type ExportsOnlyRule = (
  id: string,
  subject: SelectorInput,
  names: ReadonlyArray<string>,
  options?: RuleOptions,
) => RuleSpec

export type UsesRule = (id: string, subject: SelectorInput, use: UseSpec, options?: RuleOptions) => RuleSpec

export type NamedRule = (
  id: string,
  subject: SelectorInput,
  value: string,
  options?: RuleOptions & { readonly forbid?: boolean },
) => RuleSpec

export type MaxLinesRule = (id: string, subject: SelectorInput, max: number, options?: RuleOptions) => RuleSpec

export type CustomRule = (id: string, subject: SelectorInput, check: CustomCheck, options?: RuleOptions) => RuleSpec

export interface RuleConstructors {
  readonly forbid: ReachRule
  readonly require: ReachRule
  readonly onlyDependOn: ReachRule
  readonly forbidDependents: ReachRule
  readonly requireDependents: ReachRule
  readonly onlyDependedOnBy: ReachRule
  readonly acyclic: AcyclicRule
  readonly resolvable: ResolvableRule
  readonly declares: DeclaresRule
  readonly declaresNone: DeclaresRule
  readonly exportsOnly: ExportsOnlyRule
  readonly forbidUse: UsesRule
  readonly requireUse: UsesRule
  readonly prefix: NamedRule
  readonly suffix: NamedRule
  readonly maxLines: MaxLinesRule
  readonly custom: CustomRule
}

export interface PredicateConstructors {
  readonly kind: (...kinds: ReadonlyArray<DeclarationKind>) => DeclarationPredicate
  readonly abstract: DeclarationPredicate
  readonly exported: DeclarationPredicate
  readonly readonlyProperties: DeclarationPredicate
  readonly extends: (name: string) => DeclarationPredicate
  readonly implements: (name: string) => DeclarationPredicate
  readonly decorator: (name: string) => DeclarationPredicate
  readonly hasMethods: (names: ReadonlyArray<string>, visibility?: Visibility) => DeclarationPredicate
  readonly onlyPublicMethods: DeclarationPredicate
  readonly all: (...predicates: ReadonlyArray<DeclarationPredicate>) => DeclarationPredicate
}

export interface UseConstructors {
  readonly looseEquality: UseSpec
  readonly globals: (...names: ReadonlyArray<string>) => UseSpec
  readonly imported: (source: string, ...names: ReadonlyArray<string>) => UseSpec
}

export interface Presets {
  readonly recommended: ReadonlyArray<RuleSpec>
}

const meta = (options: RuleOptions | undefined): Meta => ({
  ...(options?.severity === undefined ? {} : { severity: options.severity }),
  ...(options?.reason === undefined ? {} : { reason: options.reason }),
})

const edges = (options: EdgeOptions | undefined, transitive: boolean): Edges => ({
  kinds: options?.kinds ?? allKinds,
  localOnly: options?.localOnly ?? false,
  transitive: options?.transitive ?? transitive,
})

const reach =
  (direction: "outgoing" | "incoming", relation: "forbid" | "require", negate: boolean): ReachRule =>
  (id, subject, object, options) => ({
    id,
    ...meta(options),
    subject,
    assertion: {
      _tag: "Reach",
      direction,
      relation,
      object: negate ? { not: object } : object,
      edges: edges(options, false),
    },
  })

const named =
  (affix: "prefix" | "suffix"): NamedRule =>
  (id, subject, value, options) => ({
    id,
    ...meta(options),
    subject,
    assertion: { _tag: "Named", relation: options?.forbid === true ? "forbid" : "require", affix, value },
  })

const declares =
  (quantifier: "every" | "none"): DeclaresRule =>
  (id, subject, predicate, options) => ({
    id,
    ...meta(options),
    subject,
    assertion: { _tag: "Declares", quantifier, predicate },
  })

const uses =
  (relation: "forbid" | "require"): UsesRule =>
  (id, subject, use, options) => ({
    id,
    ...meta(options),
    subject,
    assertion: { _tag: "Uses", relation, use },
  })

/** Rule constructors. Each returns plain data; the first argument is the rule's stable ID. */
export const r: RuleConstructors = {
  /** The subject must not reach the object. A computed import is always forbidden. */
  forbid: reach("outgoing", "forbid", false),
  /** The subject must reach something the object selects. */
  require: reach("outgoing", "require", false),
  /** The subject may reach only what the object selects. */
  onlyDependOn: reach("outgoing", "forbid", true),
  /** No source file the object selects may reach the subject. */
  forbidDependents: reach("incoming", "forbid", false),
  /** Some source file the object selects must reach the subject. */
  requireDependents: reach("incoming", "require", false),
  /** Only source files the object selects may reach the subject. */
  onlyDependedOnBy: reach("incoming", "forbid", true),
  acyclic: (id, subject, options) => ({
    id,
    ...meta(options),
    subject,
    assertion: {
      _tag: "Acyclic",
      edges: edges(options, true),
      ...(options?.folderDepth === undefined ? {} : { folderDepth: options.folderDepth }),
    },
  }),
  resolvable: (id, subject, options) => ({
    id,
    ...meta(options),
    subject,
    assertion: { _tag: "Resolvable", allowComputed: options?.allowComputed ?? false },
  }),
  /** Every declaration of the subject satisfies the predicate. A file without declarations passes. */
  declares: declares("every"),
  /** No declaration of the subject satisfies the predicate. */
  declaresNone: declares("none"),
  exportsOnly: (id, subject, names, options) => ({
    id,
    ...meta(options),
    subject,
    assertion: { _tag: "ExportsOnly", names },
  }),
  forbidUse: uses("forbid"),
  requireUse: uses("require"),
  prefix: named("prefix"),
  suffix: named("suffix"),
  maxLines: (id, subject, max, options) => ({
    id,
    ...meta(options),
    subject,
    assertion: { _tag: "MaxLines", max },
  }),
  /** A check written in code. It returns one message per finding; a throw becomes one finding. */
  custom: (id, subject, check, options) => ({
    id,
    ...meta(options),
    subject,
    assertion: { _tag: "Custom", name: id },
    check,
  }),
}

const abstract: DeclarationPredicate = { _tag: "Abstract" }
const exported: DeclarationPredicate = { _tag: "Exported" }
const readonlyProperties: DeclarationPredicate = { _tag: "ReadonlyProperties" }
const onlyPublicMethods: DeclarationPredicate = { _tag: "OnlyPublicMethods" }
const looseEquality: UseSpec = { _tag: "LooseEquality" }

/** Declaration predicates for `r.declares` and `r.declaresNone`. */
export const p: PredicateConstructors = {
  kind: (...kinds) => ({ _tag: "Kind", kinds }),
  abstract,
  exported,
  readonlyProperties,
  extends: (name) => ({ _tag: "Extends", name }),
  implements: (name) => ({ _tag: "Implements", name }),
  decorator: (name) => ({ _tag: "Decorator", name }),
  hasMethods: (names, visibility) =>
    visibility === undefined ? { _tag: "HasMethods", names } : { _tag: "HasMethods", names, visibility },
  onlyPublicMethods,
  all: (...predicates) => ({ _tag: "All", predicates }),
}

/** Uses for `r.forbidUse` and `r.requireUse`. */
export const use: UseConstructors = {
  looseEquality,
  /** Calls of these names that resolve to no declaration. */
  globals: (...names) => ({ _tag: "Globals", names }),
  /** Calls that resolve to these exports of `source`. */
  imported: (source, ...names) => ({ _tag: "Imported", source, names }),
}

export const presets: Presets = {
  /** No cycles among source files, and every import resolves. */
  recommended: [r.acyclic("archer/acyclic", "**"), r.resolvable("archer/resolvable", "**")],
}
