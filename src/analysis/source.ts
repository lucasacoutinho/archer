import { readFile } from 'node:fs/promises'
import path from 'node:path'

import ts from 'typescript'

import type {
  DeclarationInfo,
  Dependency,
  DependencyKind,
  MethodInfo,
  SourceModule,
  SourceUse,
} from '../core/types.js'

export interface ImportReference {
  readonly kind: DependencyKind
  readonly node: ts.StringLiteralLike
  readonly specifier: string
  readonly target?: string
}

export interface SourceAnalysisContext {
  readonly checker?: ts.TypeChecker
  readonly project?: string
  resolve(
    reference: ImportReference,
    sourceFile: ts.SourceFile,
  ): Omit<Dependency, 'column' | 'from' | 'kind' | 'line' | 'specifier'>
  sourceFile?: ts.SourceFile
}

function isStringLiteralLike(node: ts.Node | undefined): node is ts.StringLiteralLike {
  return (
    node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
  )
}

function importsOnlyTypes(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause
  if (clause === undefined) {
    return false
  }
  if (clause.isTypeOnly) {
    return true
  }
  if (clause.name !== undefined || clause.namedBindings === undefined) {
    return false
  }
  if (ts.isNamespaceImport(clause.namedBindings)) {
    return false
  }

  return (
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  )
}

function exportOnlyTypes(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true
  return (
    node.exportClause !== undefined &&
    ts.isNamedExports(node.exportClause) &&
    node.exportClause.elements.length > 0 &&
    node.exportClause.elements.every((element) => element.isTypeOnly)
  )
}

export function collectImports(
  sourceFile: ts.SourceFile,
  checker?: ts.TypeChecker,
): readonly ImportReference[] {
  const imports: ImportReference[] = []

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && isStringLiteralLike(statement.moduleSpecifier)) {
      imports.push({
        kind: importsOnlyTypes(statement) ? 'type' : 'static',
        node: statement.moduleSpecifier,
        specifier: statement.moduleSpecifier.text,
      })
      continue
    }

    if (ts.isExportDeclaration(statement) && isStringLiteralLike(statement.moduleSpecifier)) {
      imports.push({
        kind: exportOnlyTypes(statement) ? 'type' : 'static',
        node: statement.moduleSpecifier,
        specifier: statement.moduleSpecifier.text,
      })
      continue
    }

    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      isStringLiteralLike(statement.moduleReference.expression)
    ) {
      imports.push({
        kind: statement.isTypeOnly ? 'type' : 'require',
        node: statement.moduleReference.expression,
        specifier: statement.moduleReference.expression.text,
      })
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const argument = node.arguments[0]
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && argument !== undefined) {
        if (isStringLiteralLike(argument)) {
          imports.push({ kind: 'dynamic', node: argument, specifier: argument.text })
        } else {
          const synthetic = ts.factory.createStringLiteral(argument.getText(sourceFile))
          ts.setTextRange(synthetic, argument)
          imports.push({
            kind: 'dynamic',
            node: synthetic,
            specifier: argument.getText(sourceFile),
            target: 'dynamic:unknown',
          })
        }
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const symbol = checker?.getSymbolAtLocation(node.expression)
        const isGlobal =
          checker === undefined ||
          (symbol?.declarations?.some(
            (declaration) => declaration.getSourceFile() !== sourceFile,
          ) ??
            symbol === undefined)
        if (isGlobal && isStringLiteralLike(argument)) {
          imports.push({ kind: 'require', node: argument, specifier: argument.text })
        } else if (isGlobal && argument !== undefined) {
          const synthetic = ts.factory.createStringLiteral(argument.getText(sourceFile))
          ts.setTextRange(synthetic, argument)
          imports.push({
            kind: 'require',
            node: synthetic,
            specifier: argument.getText(sourceFile),
            target: 'dynamic:unknown',
          })
        }
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      isStringLiteralLike(node.argument.literal)
    ) {
      imports.push({
        kind: 'type',
        node: node.argument.literal,
        specifier: node.argument.literal.text,
      })
    }

    ts.forEachChild(node, visit)
  }

  ts.forEachChild(sourceFile, visit)
  return imports
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)
  )
}

function decoratorNames(node: ts.Node): readonly string[] {
  if (!ts.canHaveDecorators(node)) {
    return []
  }
  return (ts.getDecorators(node) ?? []).map((decorator) => decorator.expression.getText())
}

function visibility(node: ts.Node): MethodInfo['visibility'] {
  if (hasModifier(node, ts.SyntaxKind.PrivateKeyword)) {
    return 'private'
  }
  if (hasModifier(node, ts.SyntaxKind.ProtectedKeyword)) {
    return 'protected'
  }
  return 'public'
}

function methodsOf(node: ts.ClassDeclaration | ts.InterfaceDeclaration): readonly MethodInfo[] {
  return node.members.flatMap((member) => {
    if (!ts.isMethodDeclaration(member) && !ts.isMethodSignature(member)) {
      return []
    }
    return [
      {
        name: member.name.getText(),
        static: hasModifier(member, ts.SyntaxKind.StaticKeyword),
        visibility: visibility(member),
      },
    ]
  })
}

function declarationBase(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): Pick<
  DeclarationInfo,
  'abstract' | 'column' | 'decorators' | 'defaultExport' | 'exported' | 'line'
> {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return {
    abstract: hasModifier(node, ts.SyntaxKind.AbstractKeyword),
    column: position.character + 1,
    decorators: decoratorNames(node),
    defaultExport: hasModifier(node, ts.SyntaxKind.DefaultKeyword),
    exported: hasModifier(node, ts.SyntaxKind.ExportKeyword),
    line: position.line + 1,
  }
}

function heritage(
  node: ts.ClassDeclaration | ts.InterfaceDeclaration,
  token: ts.SyntaxKind.ExtendsKeyword | ts.SyntaxKind.ImplementsKeyword,
  checker?: ts.TypeChecker,
): readonly string[] {
  const types =
    node.heritageClauses
      ?.filter((clause) => clause.token === token)
      .flatMap((clause) => clause.types) ?? []
  return [
    ...new Set(
      types.flatMap((type) => {
        const text = type.expression.getText()
        const symbol = checker?.getSymbolAtLocation(type.expression)
        const resolvedSymbol =
          symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
            ? checker?.getAliasedSymbol(symbol)
            : symbol
        const resolved = resolvedSymbol?.getName()
        return resolved === undefined || resolved === 'unknown' || resolved === text
          ? [text]
          : [text, resolved]
      }),
    ),
  ]
}

function collectDeclarations(
  sourceFile: ts.SourceFile,
  checker?: ts.TypeChecker,
): readonly DeclarationInfo[] {
  return sourceFile.statements.flatMap((statement): readonly DeclarationInfo[] => {
    if (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      const name = statement.name?.text ?? 'default'
      return [
        {
          ...declarationBase(statement, sourceFile),
          extends: heritage(statement, ts.SyntaxKind.ExtendsKeyword, checker),
          implements: ts.isClassDeclaration(statement)
            ? heritage(statement, ts.SyntaxKind.ImplementsKeyword, checker)
            : [],
          kind: ts.isClassDeclaration(statement) ? 'class' : 'interface',
          methods: methodsOf(statement),
          name,
          readonlyProperties: statement.members
            .filter((member) => ts.isPropertyDeclaration(member) || ts.isPropertySignature(member))
            .every((member) => hasModifier(member, ts.SyntaxKind.ReadonlyKeyword)),
        },
      ]
    }
    if (ts.isEnumDeclaration(statement)) {
      return [
        {
          ...declarationBase(statement, sourceFile),
          extends: [],
          implements: [],
          kind: 'enum',
          methods: [],
          name: statement.name.text,
          readonlyProperties: true,
        },
      ]
    }
    if (ts.isFunctionDeclaration(statement)) {
      return [
        {
          ...declarationBase(statement, sourceFile),
          extends: [],
          implements: [],
          kind: 'function',
          methods: [],
          name: statement.name?.text ?? 'default',
          readonlyProperties: true,
        },
      ]
    }
    if (ts.isTypeAliasDeclaration(statement)) {
      return [
        {
          ...declarationBase(statement, sourceFile),
          extends: [],
          implements: [],
          kind: 'type',
          methods: [],
          name: statement.name.text,
          readonlyProperties: true,
        },
      ]
    }
    if (ts.isVariableStatement(statement)) {
      const base = declarationBase(statement, sourceFile)
      return statement.declarationList.declarations.map((declaration) => ({
        ...base,
        extends: [],
        implements: [],
        kind: 'variable',
        methods: [],
        name: declaration.name.getText(),
        readonlyProperties: true,
      }))
    }
    return []
  })
}

function collectUses(sourceFile: ts.SourceFile, checker?: ts.TypeChecker): readonly SourceUse[] {
  const uses: SourceUse[] = []

  function add(node: ts.Node, kind: SourceUse['kind'], name: string): void {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    uses.push({ column: position.character + 1, kind, line: position.line + 1, name })
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const symbol = checker?.getSymbolAtLocation(node.expression)
      const isGlobal =
        checker === undefined ||
        (symbol?.declarations?.some((declaration) => declaration.getSourceFile() !== sourceFile) ??
          false)
      if (isGlobal) add(node.expression, 'call', node.expression.text)
    }
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken)
    ) {
      add(node.operatorToken, 'loose-equality', node.operatorToken.getText(sourceFile))
    }
    ts.forEachChild(node, visit)
  }

  ts.forEachChild(sourceFile, visit)
  return uses
}

function collectExports(sourceFile: ts.SourceFile, checker?: ts.TypeChecker): readonly string[] {
  const moduleSymbol = checker?.getSymbolAtLocation(sourceFile)
  if (moduleSymbol !== undefined) {
    return (
      checker
        ?.getExportsOfModule(moduleSymbol)
        .map((symbol) => symbol.getName())
        .toSorted() ?? []
    )
  }
  return collectDeclarations(sourceFile)
    .filter((declaration) => declaration.exported || declaration.defaultExport)
    .map((declaration) => (declaration.defaultExport ? 'default' : declaration.name))
}

function scriptKind(fileName: string): ts.ScriptKind {
  switch (path.extname(fileName).toLowerCase()) {
    case '.js':
    case '.cjs':
    case '.mjs':
      return ts.ScriptKind.JS
    case '.jsx':
      return ts.ScriptKind.JSX
    case '.json':
      return ts.ScriptKind.JSON
    case '.tsx':
      return ts.ScriptKind.TSX
    default:
      return ts.ScriptKind.TS
  }
}

export async function analyzeSource(
  absolutePath: string,
  root: string,
  context: SourceAnalysisContext,
): Promise<SourceModule> {
  const source = await readFile(absolutePath, 'utf8')
  const sourceFile =
    context.sourceFile ??
    ts.createSourceFile(
      absolutePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(absolutePath),
    )
  const modulePath = path.relative(root, absolutePath).replaceAll('\\', '/')
  const dependencies: Dependency[] = []
  for (const reference of collectImports(sourceFile, context.checker)) {
    const position = sourceFile.getLineAndCharacterOfPosition(reference.node.getStart(sourceFile))
    dependencies.push({
      ...context.resolve(reference, sourceFile),
      column: position.character + 1,
      from: modulePath,
      kind: reference.kind,
      line: position.line + 1,
      specifier: reference.specifier,
    })
  }
  const sourceLines = source.length === 0 ? [] : source.split(/\r?\n/u)

  return {
    absolutePath,
    declarations: collectDeclarations(sourceFile, context.checker),
    dependencies,
    exports: collectExports(sourceFile, context.checker),
    lines: sourceLines.length,
    path: modulePath,
    ...(context.project === undefined ? {} : { project: context.project }),
    sourceLines,
    uses: collectUses(sourceFile, context.checker),
  }
}
