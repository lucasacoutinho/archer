import type { Selector } from './types.js'

export interface Selection {
  readonly ignored: string[]
  readonly selector: Selector
}

interface BaseRule {
  readonly negated: boolean
  readonly selection: Selection
}

export interface DependencyRule extends BaseRule {
  readonly kind: 'depend-on' | 'only-depend-on' | 'depended-on-by' | 'only-depended-on-by'
  readonly target: Selector
}

export interface CycleRule extends BaseRule {
  readonly kind: 'free-of-cycles'
}

export interface NameRule extends BaseRule {
  readonly kind: 'prefix' | 'suffix'
  readonly value: string
}

export interface LineCountRule extends BaseRule {
  readonly kind: 'line-count-less-than'
  readonly value: number
}

export type ArchitectureRule = CycleRule | DependencyRule | LineCountRule | NameRule
