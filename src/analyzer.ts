import { builtinModules } from 'node:module'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { glob } from 'tinyglobby'
import ts from 'typescript'

import type {
  ArchitectureGraph,
  ArcherOptions,
  Dependency,
  DependencyKind,
  SourceModule,
} from './types.js'

const DEFAULT_INCLUDE = ['src/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'] as const
const DEFAULT_EXCLUDE = [
  '**/*.d.ts',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
] as const

const BUILTINS = new Set(
  builtinModules.map((name) => (name.startsWith('node:') ? name.slice(5) : name)),
)

interface ImportReference {
  readonly kind: DependencyKind
  readonly node: ts.Node
  readonly specifier: string
  readonly target?: string
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/')
}

function packageTarget(specifier: string): string {
  return `npm:${specifier}`
}

function isBuiltin(specifier: string): boolean {
  const withoutPrefix = specifier.startsWith('node:') ? specifier.slice(5) : specifier
  const [root, second] = withoutPrefix.split('/')
  const candidate = root?.startsWith('@') ? `${root}/${second ?? ''}` : root
  return candidate !== undefined && BUILTINS.has(candidate)
}

function builtinTarget(specifier: string): string {
  return specifier.startsWith('node:') ? specifier : `node:${specifier}`
}

function isStringLiteralLike(node: ts.Node | undefined): node is ts.StringLiteralLike {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
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

  return clause.namedBindings.elements.length > 0
    && clause.namedBindings.elements.every((element) => element.isTypeOnly)
}

function collectImports(sourceFile: ts.SourceFile): readonly ImportReference[] {
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
        kind: statement.isTypeOnly ? 'type' : 'static',
        node: statement.moduleSpecifier,
        specifier: statement.moduleSpecifier.text,
      })
      continue
    }

    if (
      ts.isImportEqualsDeclaration(statement)
      && ts.isExternalModuleReference(statement.moduleReference)
      && isStringLiteralLike(statement.moduleReference.expression)
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
          imports.push({
            kind: 'dynamic',
            node: argument,
            specifier: argument.getText(sourceFile),
            target: 'dynamic:unknown',
          })
        }
      } else if (
        ts.isIdentifier(node.expression)
        && node.expression.text === 'require'
        && isStringLiteralLike(argument)
      ) {
        imports.push({ kind: 'require', node: argument, specifier: argument.text })
      }
    } else if (
      ts.isImportTypeNode(node)
      && ts.isLiteralTypeNode(node.argument)
      && isStringLiteralLike(node.argument.literal)
    ) {
      imports.push({ kind: 'type', node: node.argument.literal, specifier: node.argument.literal.text })
    }

    ts.forEachChild(node, visit)
  }

  ts.forEachChild(sourceFile, visit)
  return imports
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

function readCompilerOptions(root: string, tsconfig: string | false | undefined): ts.CompilerOptions {
  if (tsconfig === false) {
    return {
      allowJs: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    }
  }

  const configPath = path.resolve(root, tsconfig ?? 'tsconfig.json')
  const readResult = ts.readConfigFile(configPath, ts.sys.readFile)

  if (readResult.error !== undefined) {
    if (readResult.error.code === 5083 && tsconfig === undefined) {
      return {
        allowJs: true,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
      }
    }

    throw new Error(ts.flattenDiagnosticMessageText(readResult.error.messageText, '\n'))
  }

  const parsed = ts.parseJsonConfigFileContent(readResult.config, ts.sys, path.dirname(configPath))
  if (parsed.errors.length > 0) {
    const messages = parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
    throw new Error(`Could not read ${configPath}:\n${messages.join('\n')}`)
  }

  return { ...parsed.options, allowJs: true }
}

function dependencyTarget(
  specifier: string,
  from: string,
  root: string,
  compilerOptions: ts.CompilerOptions,
): string {
  if (isBuiltin(specifier)) {
    return builtinTarget(specifier)
  }

  const resolved = ts.resolveModuleName(specifier, from, compilerOptions, ts.sys).resolvedModule
  if (resolved !== undefined) {
    const resolvedPath = path.resolve(resolved.resolvedFileName)
    const relative = normalizePath(path.relative(root, resolvedPath))

    if (!relative.startsWith('../') && relative !== '..' && !path.isAbsolute(relative)) {
      if (!relative.split('/').includes('node_modules')) {
        return relative
      }
    }

    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      return `file:${relative}`
    }

    return packageTarget(specifier)
  }

  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    return `unresolved:${specifier}`
  }

  return packageTarget(specifier)
}

async function analyzeFile(
  absolutePath: string,
  root: string,
  compilerOptions: ts.CompilerOptions,
): Promise<SourceModule> {
  const source = await readFile(absolutePath, 'utf8')
  const sourceFile = ts.createSourceFile(
    absolutePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(absolutePath),
  )
  const modulePath = normalizePath(path.relative(root, absolutePath))
  const dependencies = collectImports(sourceFile).map<Dependency>((reference) => {
    const position = sourceFile.getLineAndCharacterOfPosition(reference.node.getStart(sourceFile))
    return {
      column: position.character + 1,
      from: modulePath,
      kind: reference.kind,
      line: position.line + 1,
      specifier: reference.specifier,
      target: reference.target
        ?? dependencyTarget(reference.specifier, absolutePath, root, compilerOptions),
    }
  })

  return {
    absolutePath,
    dependencies,
    lines: source.length === 0 ? 0 : source.split(/\r?\n/u).length,
    path: modulePath,
  }
}

export async function analyze(options: ArcherOptions = {}): Promise<ArchitectureGraph> {
  const root = path.resolve(options.root ?? process.cwd())
  const compilerOptions = readCompilerOptions(root, options.tsconfig)
  const files = await glob(options.include ?? DEFAULT_INCLUDE, {
    absolute: true,
    cwd: root,
    dot: true,
    ignore: [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])],
    onlyFiles: true,
  })
  const modules = await Promise.all(
    files.sort().map((file) => analyzeFile(path.resolve(file), root, compilerOptions)),
  )

  return {
    dependencies: modules.flatMap((sourceModule) => sourceModule.dependencies),
    modules,
    root,
  }
}
