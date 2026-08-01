import { formatSelector, matchesSelector } from '../../core/matchers.js'
import type { ArchitectureRule, Selection } from '../../core/rules.js'
import type {
  ArchitectureGraph,
  ArchitectureViolation,
  Dependency,
  SourceLocation,
  SourceModule,
} from '../../core/types.js'

export function selectedModules(
  graph: ArchitectureGraph,
  selection: Selection,
): readonly SourceModule[] {
  return graph.modules.filter(
    (sourceModule) =>
      matchesSelector(sourceModule.path, selection.selector) &&
      !selection.ignored.some((ignored) => matchesSelector(sourceModule.path, ignored)),
  )
}

export function describeRule(rule: ArchitectureRule): string {
  const subject = formatSelector(rule.selection.selector)
  switch (rule.kind) {
    case 'depend-on':
      return `${subject} must${rule.negated ? ' not' : ''} ${rule.transitive ? 'transitively ' : ''}depend on ${formatSelector(rule.target)}`
    case 'only-depend-on':
      return `${subject} must${rule.negated ? ' not' : ''} only depend on ${formatSelector(rule.target)}`
    case 'depended-on-by':
      return `${subject} must${rule.negated ? ' not' : ''} be depended on by ${formatSelector(rule.target)}`
    case 'only-depended-on-by':
      return `${subject} must${rule.negated ? ' not' : ''} only be depended on by ${formatSelector(rule.target)}`
    case 'free-of-cycles':
      return rule.collapseToFolderDepth === undefined
        ? `${subject} must be free of cycles`
        : `${subject} must be free of folder cycles`
    case 'prefix':
      return `${subject} must${rule.negated ? ' not' : ''} have prefix '${rule.value}'`
    case 'suffix':
      return `${subject} must${rule.negated ? ' not' : ''} have suffix '${rule.value}'`
    case 'line-count-less-than':
      return `${subject} must${rule.negated ? ' not' : ''} have fewer than ${rule.value} lines`
    case 'declaration-kind':
      return `${subject} must${rule.negated ? ' not' : ''} contain only ${rule.declarationKind} declarations`
    case 'abstract':
      return `${subject} must${rule.negated ? ' not' : ''} contain abstract classes`
    case 'exported':
      return `${subject} must${rule.negated ? ' not' : ''} contain exported declarations`
    case 'extend':
      return `${subject} must${rule.negated ? ' not' : ''} extend '${rule.value}'`
    case 'implement':
      return `${subject} must${rule.negated ? ' not' : ''} implement '${rule.value}'`
    case 'decorator':
      return `${subject} must${rule.negated ? ' not' : ''} use decorator '${rule.value}'`
    case 'only-export':
      return `${subject} must${rule.negated ? ' not' : ''} only export ${rule.names.join(', ')}`
    case 'readonly-properties':
      return `${subject} must${rule.negated ? ' not' : ''} have readonly properties`
    case 'strict-equality':
      return `${subject} must use strict equality`
    case 'use-globals':
      return `${subject} must${rule.negated ? ' not' : ''} use globals ${rule.globals.join(', ')}`
    case 'use-imported-symbols':
      return `${subject} must${rule.negated ? ' not' : ''} call ${rule.symbols.join(', ')} from '${rule.importedFrom}'`
    case 'have-methods':
      return `${subject} must${rule.negated ? ' not' : ''} have methods ${rule.names.join(', ')}`
    case 'have-visible-methods':
      return `${subject} must${rule.negated ? ' not' : ''} have ${rule.visibility ?? 'public'} methods ${rule.names.join(', ')}`
    case 'only-public-methods':
      return `${subject} must${rule.negated ? ' not' : ''} only have public methods ${rule.names.join(', ')}`
    case 'resolvable-dependencies':
      return `${subject} must have resolvable dependencies`
    case 'public-api':
      return `${subject} must${rule.negated ? ' not' : ''} be public API files`
    case 'custom':
      return rule.id ?? 'custom architecture rule'
  }
}

function sourceLine(
  sourceModule: SourceModule | undefined,
  line: number | undefined,
): string | undefined {
  if (sourceModule === undefined || line === undefined) {
    return undefined
  }
  return sourceModule.sourceLines[line - 1]
}

export function makeViolation(
  rule: ArchitectureRule,
  message: string,
  sourceModule?: SourceModule,
  dependency?: Dependency,
  location?: SourceLocation,
  importChain?: readonly string[],
): ArchitectureViolation {
  const line = dependency?.line ?? location?.line
  const column = dependency?.column ?? location?.column
  const content = sourceLine(sourceModule, line)
  return {
    ...(column === undefined ? {} : { column }),
    ...(dependency === undefined ? {} : { dependency: dependency.target }),
    ...(sourceModule === undefined ? {} : { file: sourceModule.path }),
    ...(importChain === undefined ? {} : { importChain }),
    ...(line === undefined ? {} : { line }),
    message,
    ...(rule.reason === undefined ? {} : { reason: rule.reason }),
    rule: describeRule(rule),
    ...(rule.id === undefined ? {} : { ruleId: rule.id }),
    severity: rule.severity,
    ...(content === undefined ? {} : { sourceLine: content }),
  }
}

export function noMatchViolation(rule: ArchitectureRule): ArchitectureViolation {
  return makeViolation(rule, `No files matched ${formatSelector(rule.selection.selector)}.`)
}
