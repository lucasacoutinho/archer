import path from 'node:path'

import type {
  ArchitectureRule,
  DeclarationKindRule,
  DeclarationModifierRule,
  DecoratorRule,
  ExportRule,
  GlobalUseRule,
  HeritageRule,
  ImportedSymbolUseRule,
  LineCountRule,
  MethodRule,
  NameRule,
  PublicApiRule,
  ReadonlyRule,
  ResolutionRule,
  StrictEqualityRule,
} from '../../core/rules.js'
import type { ArchitectureViolation, DeclarationInfo, SourceModule } from '../../core/types.js'
import { publicApiFile } from './cycles.js'
import { makeViolation } from './shared.js'

function namedDeclarationViolation(
  rule: ArchitectureRule,
  sourceModule: SourceModule,
  declaration: DeclarationInfo,
  message: string,
): ArchitectureViolation {
  return makeViolation(rule, message, sourceModule, undefined, declaration)
}

export function evaluateNameRule(
  rule: NameRule,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  return subjects.flatMap((subject) => {
    const fileName = path.basename(subject.path)
    const matches =
      rule.kind === 'prefix' ? fileName.startsWith(rule.value) : fileName.endsWith(rule.value)
    return matches !== rule.negated
      ? []
      : [makeViolation(rule, `File name is '${fileName}'.`, subject)]
  })
}

export function evaluateLineCountRule(
  rule: LineCountRule,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  return subjects.flatMap((subject) => {
    const matches = subject.lines < rule.value
    return matches !== rule.negated
      ? []
      : [makeViolation(rule, `File has ${subject.lines} lines.`, subject)]
  })
}

export function evaluateDeclarationKindRule(
  rule: DeclarationKindRule,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  return subjects.flatMap((subject) => {
    if (subject.declarations.length === 0) {
      return [makeViolation(rule, 'File has no top-level declarations.', subject)]
    }
    return subject.declarations.flatMap((declaration) => {
      const matches = declaration.kind === rule.declarationKind
      return matches !== rule.negated
        ? []
        : [
            namedDeclarationViolation(
              rule,
              subject,
              declaration,
              `'${declaration.name}' is a ${declaration.kind}, not a ${rule.declarationKind}.`,
            ),
          ]
    })
  })
}

export function evaluateDeclarationModifierRule(
  rule: DeclarationModifierRule,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  return subjects.flatMap((subject) => {
    const declarations = subject.declarations.filter(
      (declaration) => rule.kind === 'exported' || declaration.kind === 'class',
    )
    if (declarations.length === 0) {
      return [
        makeViolation(rule, `File has no declarations applicable to '${rule.kind}'.`, subject),
      ]
    }
    return declarations.flatMap((declaration) => {
      const matches =
        rule.kind === 'abstract'
          ? declaration.abstract
          : subject.exports.includes(declaration.name) ||
            (declaration.defaultExport && subject.exports.includes('default'))
      return matches !== rule.negated
        ? []
        : [
            namedDeclarationViolation(
              rule,
              subject,
              declaration,
              `'${declaration.name}' is${matches ? '' : ' not'} ${rule.kind}.`,
            ),
          ]
    })
  })
}

export function evaluateHeritageRule(
  rule: HeritageRule,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  return subjects.flatMap((subject) => {
    const declarations = subject.declarations.filter(
      (declaration) => declaration.kind === 'class' || declaration.kind === 'interface',
    )
    if (declarations.length === 0) {
      return [makeViolation(rule, 'File has no class or interface declarations.', subject)]
    }
    return declarations.flatMap((declaration) => {
      const values = rule.kind === 'extend' ? declaration.extends : declaration.implements
      const matches = values.some(
        (value) => value === rule.value || value.endsWith(`.${rule.value}`),
      )
      return matches !== rule.negated
        ? []
        : [
            namedDeclarationViolation(
              rule,
              subject,
              declaration,
              `'${declaration.name}' ${rule.kind === 'extend' ? 'extends' : 'implements'} ${values.join(', ') || 'nothing'}.`,
            ),
          ]
    })
  })
}

export function evaluateDecoratorRule(
  rule: DecoratorRule,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  return subjects.flatMap((subject) => {
    const declarations = subject.declarations.filter((declaration) => declaration.kind === 'class')
    if (declarations.length === 0) {
      return [makeViolation(rule, 'File has no class declarations.', subject)]
    }
    return declarations.flatMap((declaration) => {
      const matches = declaration.decorators.some(
        (decorator) => decorator === rule.value || decorator.startsWith(`${rule.value}(`),
      )
      return matches !== rule.negated
        ? []
        : [
            namedDeclarationViolation(
              rule,
              subject,
              declaration,
              `'${declaration.name}' has decorators ${declaration.decorators.join(', ') || 'none'}.`,
            ),
          ]
    })
  })
}

export function evaluateExportRule(
  rule: ExportRule,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  return subjects.flatMap((subject) => {
    const outside = subject.exports.filter((name) => !rule.names.includes(name))
    if (rule.negated) {
      return outside.length === 0
        ? [
            makeViolation(
              rule,
              `Every export matches ${rule.names.join(', ') || 'nothing'}.`,
              subject,
            ),
          ]
        : []
    }
    return outside.map((name) => makeViolation(rule, `'${name}' is exported.`, subject))
  })
}

export function evaluateReadonlyRule(
  rule: ReadonlyRule,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  return subjects.flatMap((subject) => {
    const declarations = subject.declarations.filter((declaration) => declaration.kind === 'class')
    if (declarations.length === 0) {
      return [makeViolation(rule, 'File has no class declarations.', subject)]
    }
    return declarations.flatMap((declaration) =>
      declaration.readonlyProperties !== rule.negated
        ? []
        : [
            namedDeclarationViolation(
              rule,
              subject,
              declaration,
              `'${declaration.name}' has mutable properties.`,
            ),
          ],
    )
  })
}

export function evaluateStrictEqualityRule(
  rule: StrictEqualityRule,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  return subjects.flatMap((subject) =>
    subject.uses
      .filter((use) => use.kind === 'loose-equality')
      .map((use) =>
        makeViolation(rule, `Uses loose equality operator '${use.name}'.`, subject, undefined, use),
      ),
  )
}

export function evaluateGlobalUseRule(
  rule: GlobalUseRule,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  return subjects.flatMap((subject) => {
    const matching = subject.uses.filter(
      (use) => use.kind === 'call' && rule.globals.includes(use.name),
    )
    if (rule.negated) {
      return matching.map((use) =>
        makeViolation(rule, `Calls '${use.name}()'.`, subject, undefined, use),
      )
    }
    const present = new Set(matching.map((use) => use.name))
    return rule.globals
      .filter((name) => !present.has(name))
      .map((name) => makeViolation(rule, `Does not call '${name}()'.`, subject))
  })
}

function matchesImportedFrom(actual: string | undefined, expected: string): boolean {
  return actual === expected || actual?.startsWith(`${expected}/`) === true
}

export function evaluateImportedSymbolUseRule(
  rule: ImportedSymbolUseRule,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  return subjects.flatMap((subject) => {
    const matching = subject.uses.filter(
      (use) =>
        use.kind === 'call' &&
        matchesImportedFrom(use.importedFrom, rule.importedFrom) &&
        use.importedName !== undefined &&
        rule.symbols.includes(use.importedName),
    )
    if (rule.negated) {
      return matching.map((use) =>
        makeViolation(
          rule,
          `Calls '${use.name}()' imported as '${use.importedName}' from '${use.importedFrom}'.`,
          subject,
          undefined,
          use,
        ),
      )
    }
    const present = new Set(matching.map((use) => use.importedName))
    return rule.symbols
      .filter((symbol) => !present.has(symbol))
      .map((symbol) =>
        makeViolation(
          rule,
          `Does not call '${symbol}()' imported from '${rule.importedFrom}'.`,
          subject,
        ),
      )
  })
}

export function evaluateMethodRule(
  rule: MethodRule,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  return subjects.flatMap((subject) => {
    const declarations = subject.declarations.filter(
      (declaration) => declaration.kind === 'class' || declaration.kind === 'interface',
    )
    if (declarations.length === 0) {
      return [makeViolation(rule, 'File has no class or interface declarations.', subject)]
    }
    return declarations.flatMap((declaration) => {
      const methods = declaration.methods.map((method) => method.name)
      const matches =
        rule.kind === 'only-public-methods'
          ? declaration.methods.every((method) => method.visibility === 'public') &&
            (rule.names.length === 0 || methods.every((method) => rule.names.includes(method)))
          : rule.kind === 'have-visible-methods'
            ? rule.names.every((name) =>
                declaration.methods.some(
                  (method) => method.name === name && method.visibility === rule.visibility,
                ),
              )
            : rule.names.every((method) => methods.includes(method))
      return matches !== rule.negated
        ? []
        : [
            namedDeclarationViolation(
              rule,
              subject,
              declaration,
              `'${declaration.name}' has methods ${methods.join(', ') || 'none'}.`,
            ),
          ]
    })
  })
}

export function evaluateResolutionRule(
  rule: ResolutionRule,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  return subjects.flatMap((subject) =>
    subject.dependencies
      .filter(
        (dependency) =>
          !dependency.resolved && (!rule.allowDynamic || dependency.resolution !== 'dynamic'),
      )
      .map((dependency) =>
        makeViolation(rule, `Cannot resolve '${dependency.specifier}'.`, subject, dependency),
      ),
  )
}

export function evaluatePublicApiRule(
  rule: PublicApiRule,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  return subjects.flatMap((subject) => {
    const matches = publicApiFile(subject.path)
    return matches !== rule.negated
      ? []
      : [makeViolation(rule, `'${path.basename(subject.path)}' is not a public API file.`, subject)]
  })
}
