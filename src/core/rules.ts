import type {
  CustomRule,
  DeclarationKind,
  DependencyKind,
  RuleSeverity,
  Selector,
} from './types.js'

export interface Selection {
  readonly ignored: string[]
  readonly selector: Selector
}

export interface RuleBase {
  id?: string
  readonly kind: string
  reason?: string
  readonly selection: Selection
  severity: RuleSeverity
}

export interface DependencyRule extends RuleBase {
  readonly dependencyKinds?: readonly DependencyKind[]
  readonly kind: 'depend-on' | 'only-depend-on' | 'depended-on-by' | 'only-depended-on-by'
  readonly localOnly: boolean
  readonly negated: boolean
  readonly target: Selector
  readonly transitive: boolean
}

export interface CycleRule extends RuleBase {
  readonly collapseToFolderDepth?: number
  readonly dependencyKinds?: readonly DependencyKind[]
  readonly kind: 'free-of-cycles'
}

export interface NameRule extends RuleBase {
  readonly kind: 'prefix' | 'suffix'
  readonly negated: boolean
  readonly value: string
}

export interface LineCountRule extends RuleBase {
  readonly kind: 'line-count-less-than'
  readonly negated: boolean
  readonly value: number
}

export interface DeclarationKindRule extends RuleBase {
  readonly declarationKind: DeclarationKind
  readonly kind: 'declaration-kind'
  readonly negated: boolean
}

export interface DeclarationModifierRule extends RuleBase {
  readonly kind: 'abstract' | 'exported'
  readonly negated: boolean
}

export interface HeritageRule extends RuleBase {
  readonly kind: 'extend' | 'implement'
  readonly negated: boolean
  readonly value: string
}

export interface DecoratorRule extends RuleBase {
  readonly kind: 'decorator'
  readonly negated: boolean
  readonly value: string
}

export interface ExportRule extends RuleBase {
  readonly kind: 'only-export'
  readonly names: readonly string[]
  readonly negated: boolean
}

export interface ReadonlyRule extends RuleBase {
  readonly kind: 'readonly-properties'
  readonly negated: boolean
}

export interface StrictEqualityRule extends RuleBase {
  readonly kind: 'strict-equality'
}

export interface GlobalUseRule extends RuleBase {
  readonly globals: readonly string[]
  readonly kind: 'use-globals'
  readonly negated: boolean
}

export interface MethodRule extends RuleBase {
  readonly kind: 'have-methods' | 'have-visible-methods' | 'only-public-methods'
  readonly names: readonly string[]
  readonly negated: boolean
  readonly visibility?: 'private' | 'protected' | 'public'
}

export interface ResolutionRule extends RuleBase {
  readonly allowDynamic: boolean
  readonly kind: 'resolvable-dependencies'
}

export interface PublicApiRule extends RuleBase {
  readonly kind: 'public-api'
  readonly negated: boolean
}

export interface CustomRuleDefinition extends RuleBase {
  readonly evaluator: CustomRule
  readonly kind: 'custom'
}

export type ArchitectureRule =
  | CustomRuleDefinition
  | CycleRule
  | DeclarationKindRule
  | DeclarationModifierRule
  | DecoratorRule
  | DependencyRule
  | ExportRule
  | GlobalUseRule
  | HeritageRule
  | LineCountRule
  | MethodRule
  | NameRule
  | PublicApiRule
  | ReadonlyRule
  | ResolutionRule
  | StrictEqualityRule
