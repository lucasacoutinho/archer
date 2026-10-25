import { Match } from "effect"
import {
  isArrayBindingPattern,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isConstructorDeclaration,
  isDecorator,
  isElementAccessExpression,
  isEnumDeclaration,
  isExportAssignment,
  isExportDeclaration,
  isExternalModuleReference,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isInterfaceDeclaration,
  isLiteralTypeNode,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isNamedExports,
  isObjectBindingPattern,
  isParameterDeclaration,
  isPrivateIdentifier,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isPropertySignatureDeclaration,
  isStringLiteralLikeNode,
  isTypeAliasDeclaration,
  isVariableStatement,
  ModifierFlags,
  ScriptKind,
  SyntaxKind,
  type BindingName,
  type CallExpression,
  type ClassDeclaration,
  type ExportDeclaration,
  type Identifier,
  type ImportDeclaration,
  type InterfaceDeclaration,
  type Node,
  type PropertyAccessExpression,
  type SourceFile,
} from "typescript/unstable/ast"
import type { Declaration, DependencyKind, Location, Method, Visibility } from "../core/model.ts"

export const locationOf = (sourceFile: SourceFile, node: Node): Location => {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return { line: line + 1, column: character + 1 }
}

/** A trailing newline ends the last line instead of starting another; an empty file has no lines. */
export const countLines = (text: string): number => {
  if (text === "") {
    return 0
  }
  let lines = text.endsWith("\n") ? 0 : 1
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) {
    lines++
  }
  return lines
}

const hasFlag = (node: { readonly modifierFlags: ModifierFlags }, flag: ModifierFlags): boolean =>
  (node.modifierFlags & flag) !== 0

export interface ImportSite {
  readonly kind: DependencyKind
  readonly node: Node
  readonly specifier: string
  readonly computed: boolean
  /** The checker does not resolve `require()` in a TypeScript file. */
  readonly checkable: boolean
}

export interface CallSite {
  readonly name: string
  readonly root: Identifier
  readonly member: string | undefined
  readonly callee: Node
}

export interface Scan {
  readonly sites: ReadonlyArray<ImportSite>
  readonly calls: ReadonlyArray<CallSite>
  readonly looseEqualities: ReadonlyArray<Node>
}

type Callee =
  | { readonly _tag: "ImportKeyword" }
  | { readonly _tag: "Name"; readonly identifier: Identifier }
  | { readonly _tag: "Member"; readonly root: Identifier; readonly member: string }
  | { readonly _tag: "Other" }

const memberOf = (object: Node, member: string | undefined): Callee =>
  isIdentifier(object) && member !== undefined ? { _tag: "Member", root: object, member } : { _tag: "Other" }

const calleeOf: (node: Node) => Callee = Match.type<Node>().pipe(
  Match.when(isIdentifier, (identifier): Callee => ({ _tag: "Name", identifier })),
  Match.when(isPropertyAccessExpression, (access): Callee => memberOf(access.expression, propertyName(access))),
  Match.when(isElementAccessExpression, (access): Callee =>
    memberOf(access.expression, isStringLiteralLikeNode(access.argumentExpression) ? access.argumentExpression.text : undefined),
  ),
  Match.when(
    (node: Node) => node.kind === SyntaxKind.ImportKeyword,
    (): Callee => ({ _tag: "ImportKeyword" }),
  ),
  Match.orElse((): Callee => ({ _tag: "Other" })),
)

const propertyName = (access: PropertyAccessExpression): string | undefined =>
  isIdentifier(access.name) ? access.name.text : undefined

/** An empty `import {} from` still runs the module, so it is not type-only. */
const importsOnlyTypes = (declaration: ImportDeclaration): boolean => {
  const clause = declaration.importClause
  if (clause === undefined) {
    return false
  }
  if (clause.phaseModifier === SyntaxKind.TypeKeyword) {
    return true
  }
  const bindings = clause.namedBindings
  return (
    clause.name === undefined &&
    bindings !== undefined &&
    bindings.kind === SyntaxKind.NamedImports &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  )
}

const exportsOnlyTypes = (declaration: ExportDeclaration): boolean => {
  const clause = declaration.exportClause
  return (
    declaration.isTypeOnly ||
    (clause !== undefined &&
      isNamedExports(clause) &&
      clause.elements.length > 0 &&
      clause.elements.every((element) => element.isTypeOnly))
  )
}

export const scanSource = (sourceFile: SourceFile): Scan => {
  const sites: Array<ImportSite> = []
  const calls: Array<CallSite> = []
  const looseEqualities: Array<Node> = []
  const scripted = sourceFile.scriptKind === ScriptKind.JS || sourceFile.scriptKind === ScriptKind.JSX

  const addLiteral = (kind: DependencyKind, node: Node | undefined, checkable: boolean): void => {
    if (node !== undefined && isStringLiteralLikeNode(node)) {
      sites.push({ kind, node, specifier: node.text, computed: false, checkable })
    }
  }

  const addArgument = (kind: DependencyKind, argument: Node, checkable: boolean): void => {
    if (isStringLiteralLikeNode(argument)) {
      addLiteral(kind, argument, checkable)
    } else {
      sites.push({ kind, node: argument, specifier: argument.getText(sourceFile), computed: true, checkable: false })
    }
  }

  const addCall = (call: CallExpression): void => {
    const [first] = call.arguments
    Match.valueTags(calleeOf(call.expression), {
      ImportKeyword: () => {
        if (first !== undefined) {
          addArgument("dynamic", first, true)
        }
      },
      Name: ({ identifier }) => {
        if (identifier.text === "require" && call.arguments.length === 1 && first !== undefined) {
          addArgument("require", first, scripted)
        }
        calls.push({ name: identifier.text, root: identifier, member: undefined, callee: identifier })
      },
      Member: ({ root, member }) => {
        calls.push({ name: `${root.text}.${member}`, root, member, callee: call.expression })
      },
      Other: () => undefined,
    })
  }

  const read = Match.type<Node>().pipe(
    Match.when(isImportDeclaration, (node): boolean => {
      addLiteral(importsOnlyTypes(node) ? "type" : "static", node.moduleSpecifier, true)
      return false
    }),
    Match.when(isExportDeclaration, (node): boolean => {
      addLiteral(exportsOnlyTypes(node) ? "type" : "static", node.moduleSpecifier, true)
      return false
    }),
    Match.when(isImportEqualsDeclaration, (node): boolean => {
      if (isExternalModuleReference(node.moduleReference)) {
        addLiteral(node.isTypeOnly ? "type" : "require", node.moduleReference.expression, true)
      }
      return false
    }),
    Match.when(isCallExpression, (node): boolean => {
      addCall(node)
      return true
    }),
    Match.when(isImportTypeNode, (node): boolean => {
      addLiteral("type", isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, true)
      return true
    }),
    Match.when(isBinaryExpression, (node): boolean => {
      if (node.operatorToken.kind === SyntaxKind.EqualsEqualsToken || node.operatorToken.kind === SyntaxKind.ExclamationEqualsToken) {
        looseEqualities.push(node.operatorToken)
      }
      return true
    }),
    Match.orElse((): boolean => true),
  )

  const visit = (node: Node): undefined => {
    if (read(node)) {
      node.forEachChild(visit)
    }
    return undefined
  }
  sourceFile.forEachChild(visit)
  return { sites, calls, looseEqualities }
}

export const requiredModule = (node: Node | undefined): string | undefined =>
  node !== undefined &&
  isCallExpression(node) &&
  isIdentifier(node.expression) &&
  node.expression.text === "require" &&
  node.arguments.length === 1 &&
  node.arguments[0] !== undefined &&
  isStringLiteralLikeNode(node.arguments[0])
    ? node.arguments[0].text
    : undefined

const memberName = (name: Node): string =>
  isIdentifier(name) || isPrivateIdentifier(name) || isStringLiteralLikeNode(name) ? name.text : name.getText()

const visibilityOf = (flags: ModifierFlags, name: Node): Visibility =>
  Match.value(flags).pipe(
    Match.when(
      (value) => (value & ModifierFlags.Private) !== 0 || isPrivateIdentifier(name),
      (): Visibility => "private",
    ),
    Match.when((value) => (value & ModifierFlags.Protected) !== 0, (): Visibility => "protected"),
    Match.orElse((): Visibility => "public"),
  )

const methodOf = (member: Node): Method | undefined =>
  isMethodDeclaration(member) || isMethodSignatureDeclaration(member)
    ? {
        name: memberName(member.name),
        visibility: visibilityOf(member.modifierFlags, member.name),
        isStatic: hasFlag(member, ModifierFlags.Static),
      }
    : undefined

/** Overload signatures collapse into one entry. */
const methodsOf = (members: ReadonlyArray<Node>): ReadonlyArray<Method> => {
  const seen = new Set<string>()
  const methods: Array<Method> = []
  for (const member of members) {
    const method = methodOf(member)
    const key = method === undefined ? "" : `${method.visibility}|${method.isStatic}|${method.name}`
    if (method !== undefined && !seen.has(key)) {
      seen.add(key)
      methods.push(method)
    }
  }
  return methods
}

const parameterPropertyFlags: ModifierFlags = ModifierFlags.Public | ModifierFlags.Private | ModifierFlags.Protected | ModifierFlags.Readonly

/** Constructor parameter properties count as properties. */
const hasOnlyReadonlyProperties = (members: ReadonlyArray<Node>): boolean => {
  const properties = members.flatMap((member): ReadonlyArray<{ readonly modifierFlags: ModifierFlags }> =>
    isPropertyDeclaration(member) || isPropertySignatureDeclaration(member)
      ? [member]
      : isConstructorDeclaration(member)
        ? member.parameters.filter((parameter) => isParameterDeclaration(parameter) && (parameter.modifierFlags & parameterPropertyFlags) !== 0)
        : [],
  )
  return properties.length > 0 && properties.every((property) => hasFlag(property, ModifierFlags.Readonly))
}

/** `Controller` for `@Controller` and `@Controller()`. */
const decoratorNames = (sourceFile: SourceFile, node: ClassDeclaration | InterfaceDeclaration): ReadonlyArray<string> =>
  (isClassDeclaration(node) ? (node.modifiers ?? []) : []).flatMap((modifier) =>
    isDecorator(modifier)
      ? [(isCallExpression(modifier.expression) ? modifier.expression.expression : modifier.expression).getText(sourceFile)]
      : [],
  )

const heritageNames = (
  sourceFile: SourceFile,
  node: ClassDeclaration | InterfaceDeclaration,
  token: SyntaxKind.ExtendsKeyword | SyntaxKind.ImplementsKeyword,
): ReadonlyArray<string> =>
  (node.heritageClauses ?? [])
    .filter((clause) => clause.token === token)
    .flatMap((clause) => clause.types.map((type) => type.expression.getText(sourceFile)))

const boundNames = (name: BindingName): ReadonlyArray<string> =>
  Match.value(name).pipe(
    Match.when(isIdentifier, (identifier) => [identifier.text]),
    Match.when(isObjectBindingPattern, (pattern) => pattern.elements.flatMap((element) => (element.name === undefined ? [] : boundNames(element.name)))),
    Match.when(isArrayBindingPattern, (pattern) =>
      pattern.elements.flatMap((element) => (element.kind === SyntaxKind.BindingElement && element.name !== undefined ? boundNames(element.name) : [])),
    ),
    Match.orElse(() => []),
  )

/** Names exported by `export { a as b }` and `export default a` instead of by a modifier. */
const exportedLocalNames = (sourceFile: SourceFile): ReadonlySet<string> => {
  const names = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (isExportDeclaration(statement) && statement.moduleSpecifier === undefined && statement.exportClause !== undefined && isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        names.add((element.propertyName ?? element.name).text)
      }
    } else if (isExportAssignment(statement) && isIdentifier(statement.expression)) {
      names.add(statement.expression.text)
    }
  }
  return names
}

/** A variable statement gives one declaration per bound name, all at the statement's location. */
export const declarationsOf = (sourceFile: SourceFile): ReadonlyArray<Declaration> => {
  const exportedNames = exportedLocalNames(sourceFile)
  const base = (
    node: Node & { readonly modifierFlags: ModifierFlags },
    name: string,
  ): Pick<Declaration, "name" | "exported" | "abstract" | "location"> => ({
    name,
    exported: hasFlag(node, ModifierFlags.Export) || exportedNames.has(name),
    abstract: hasFlag(node, ModifierFlags.Abstract),
    location: locationOf(sourceFile, node),
  })
  const plain = { extended: [], implemented: [], decorators: [], methods: [], readonlyProperties: false } as const

  const read = Match.type<Node>().pipe(
    Match.when(isClassDeclaration, (node): ReadonlyArray<Declaration> => [
      {
        ...base(node, node.name?.text ?? "default"),
        kind: "class",
        extended: heritageNames(sourceFile, node, SyntaxKind.ExtendsKeyword),
        implemented: heritageNames(sourceFile, node, SyntaxKind.ImplementsKeyword),
        decorators: decoratorNames(sourceFile, node),
        methods: methodsOf(node.members),
        readonlyProperties: hasOnlyReadonlyProperties(node.members),
      },
    ]),
    Match.when(isInterfaceDeclaration, (node): ReadonlyArray<Declaration> => [
      {
        ...base(node, node.name.text),
        kind: "interface",
        extended: heritageNames(sourceFile, node, SyntaxKind.ExtendsKeyword),
        implemented: [],
        decorators: [],
        methods: methodsOf(node.members),
        readonlyProperties: hasOnlyReadonlyProperties(node.members),
      },
    ]),
    Match.when(isEnumDeclaration, (node): ReadonlyArray<Declaration> => [{ ...base(node, node.name.text), kind: "enum", ...plain }]),
    Match.when(isFunctionDeclaration, (node): ReadonlyArray<Declaration> => [
      { ...base(node, node.name?.text ?? "default"), kind: "function", ...plain },
    ]),
    Match.when(isTypeAliasDeclaration, (node): ReadonlyArray<Declaration> => [{ ...base(node, node.name.text), kind: "type", ...plain }]),
    Match.when(isVariableStatement, (node): ReadonlyArray<Declaration> =>
      node.declarationList.declarations
        .flatMap((declaration) => boundNames(declaration.name))
        .map((name) => ({ ...base(node, name), kind: "variable", ...plain })),
    ),
    Match.orElse((): ReadonlyArray<Declaration> => []),
  )

  const functions = new Set<string>()
  return sourceFile.statements.flatMap(read).filter((declaration) => {
    if (declaration.kind !== "function") {
      return true
    }
    const fresh = !functions.has(declaration.name)
    functions.add(declaration.name)
    return fresh
  })
}
