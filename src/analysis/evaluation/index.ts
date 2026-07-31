import type { ArchitectureRule } from '../../core/rules.js'
import type { ArchitectureGraph, ArchitectureViolation } from '../../core/types.js'
import { evaluateCycleRule } from './cycles.js'
import { evaluateDependencyRule } from './dependencies.js'
import {
  evaluateDeclarationKindRule,
  evaluateDeclarationModifierRule,
  evaluateDecoratorRule,
  evaluateExportRule,
  evaluateGlobalUseRule,
  evaluateHeritageRule,
  evaluateLineCountRule,
  evaluateMethodRule,
  evaluateNameRule,
  evaluatePublicApiRule,
  evaluateReadonlyRule,
  evaluateResolutionRule,
  evaluateStrictEqualityRule,
} from './semantic.js'
import { noMatchViolation, selectedModules } from './shared.js'

export async function evaluateRule(
  graph: ArchitectureGraph,
  rule: ArchitectureRule,
): Promise<readonly ArchitectureViolation[]> {
  const subjects = selectedModules(graph, rule.selection)
  if (subjects.length === 0) {
    return [noMatchViolation(rule)]
  }
  switch (rule.kind) {
    case 'depend-on':
    case 'only-depend-on':
    case 'depended-on-by':
    case 'only-depended-on-by':
      return evaluateDependencyRule(graph, rule, subjects)
    case 'free-of-cycles':
      return evaluateCycleRule(rule, subjects)
    case 'prefix':
    case 'suffix':
      return evaluateNameRule(rule, subjects)
    case 'line-count-less-than':
      return evaluateLineCountRule(rule, subjects)
    case 'declaration-kind':
      return evaluateDeclarationKindRule(rule, subjects)
    case 'abstract':
    case 'exported':
      return evaluateDeclarationModifierRule(rule, subjects)
    case 'extend':
    case 'implement':
      return evaluateHeritageRule(rule, subjects)
    case 'decorator':
      return evaluateDecoratorRule(rule, subjects)
    case 'only-export':
      return evaluateExportRule(rule, subjects)
    case 'readonly-properties':
      return evaluateReadonlyRule(rule, subjects)
    case 'strict-equality':
      return evaluateStrictEqualityRule(rule, subjects)
    case 'use-globals':
      return evaluateGlobalUseRule(rule, subjects)
    case 'have-methods':
    case 'have-visible-methods':
    case 'only-public-methods':
      return evaluateMethodRule(rule, subjects)
    case 'resolvable-dependencies':
      return evaluateResolutionRule(rule, subjects)
    case 'public-api':
      return evaluatePublicApiRule(rule, subjects)
    case 'custom': {
      const result = await rule.evaluator({ graph, modules: subjects })
      if (result === undefined) {
        return []
      }
      const violations = Array.isArray(result) ? [...result] : [result as ArchitectureViolation]
      const normalized: ArchitectureViolation[] = []
      for (const violation of violations) {
        normalized.push({
          ...violation,
          ...(rule.reason === undefined ? {} : { reason: rule.reason }),
          ...(rule.id === undefined ? {} : { ruleId: rule.id }),
          severity: rule.severity,
        })
      }
      return normalized
    }
  }
}
