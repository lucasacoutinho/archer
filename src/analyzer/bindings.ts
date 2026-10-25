import { Match } from "effect"
import type { Project, Symbol as TsSymbol } from "typescript/unstable/async"
import {
  isBindingElement,
  isExternalModuleReference,
  isIdentifier,
  isImportClause,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportSpecifier,
  isNamespaceImport,
  isObjectBindingPattern,
  isStringLiteralLikeNode,
  isVariableDeclaration,
  type Node,
} from "typescript/unstable/ast"
import type { Binding } from "../core/model.ts"
import { requiredModule } from "./syntax.ts"

export interface ImportOrigin {
  readonly source: string
  /** `default` for a default import, `*` for the whole module. */
  readonly name: string
  /** `name.member()` calls `member` on the module. */
  readonly namespace: boolean
}

export type SymbolKind =
  | { readonly _tag: "Global" }
  | { readonly _tag: "Local" }
  | { readonly _tag: "Import"; readonly origin: ImportOrigin }

const GLOBAL: SymbolKind = { _tag: "Global" }
const LOCAL: SymbolKind = { _tag: "Local" }

const importedFrom = (node: Node): string | undefined =>
  isImportDeclaration(node) && isStringLiteralLikeNode(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined

const originOf: (declaration: Node) => ImportOrigin | undefined = Match.type<Node>().pipe(
  Match.when(isImportSpecifier, (specifier): ImportOrigin | undefined => {
    const source = importedFrom(specifier.parent.parent.parent)
    return source === undefined
      ? undefined
      : { source, name: (specifier.propertyName ?? specifier.name).text, namespace: false }
  }),
  Match.when(isImportClause, (clause): ImportOrigin | undefined => {
    const source = importedFrom(clause.parent)
    return source === undefined ? undefined : { source, name: "default", namespace: true }
  }),
  Match.when(isNamespaceImport, (namespace): ImportOrigin | undefined => {
    const source = importedFrom(namespace.parent.parent)
    return source === undefined ? undefined : { source, name: "*", namespace: true }
  }),
  Match.when(isImportEqualsDeclaration, (declaration): ImportOrigin | undefined =>
    isExternalModuleReference(declaration.moduleReference) && isStringLiteralLikeNode(declaration.moduleReference.expression)
      ? { source: declaration.moduleReference.expression.text, name: "*", namespace: true }
      : undefined,
  ),
  Match.when(isVariableDeclaration, (declaration): ImportOrigin | undefined => {
    const source = requiredModule(declaration.initializer)
    return source !== undefined && isIdentifier(declaration.name) ? { source, name: "*", namespace: true } : undefined
  }),
  Match.when(isBindingElement, (element): ImportOrigin | undefined => {
    const pattern = element.parent
    const declaration = pattern.parent
    const source = isObjectBindingPattern(pattern) && isVariableDeclaration(declaration) ? requiredModule(declaration.initializer) : undefined
    const property = element.propertyName ?? element.name
    return source !== undefined &&
      element.dotDotDotToken === undefined &&
      property !== undefined &&
      (isIdentifier(property) || isStringLiteralLikeNode(property))
      ? { source, name: property.text, namespace: false }
      : undefined
  }),
  Match.orElse((): ImportOrigin | undefined => undefined),
)

/**
 * No declaration in this file is a global, whether a library declares it or nothing does.
 * Only declarations in this file are resolved, so a lookup never fetches a library file.
 */
export const classifySymbol = async (project: Project, filePath: string, symbol: TsSymbol | undefined): Promise<SymbolKind> => {
  const here = (symbol?.declarations ?? []).filter((declaration) => declaration.path === filePath)
  for (const declaration of here) {
    const node = await declaration.resolve(project)
    const origin = node === undefined ? undefined : originOf(node)
    if (origin !== undefined) {
      return { _tag: "Import", origin }
    }
  }
  return here.length === 0 ? GLOBAL : LOCAL
}

export const bindingOfName = (kind: SymbolKind): Binding =>
  Match.valueTags(kind, {
    Global: (): Binding => ({ _tag: "Global" }),
    Local: (): Binding => ({ _tag: "Local" }),
    Import: ({ origin }): Binding => ({ _tag: "Imported", name: { source: origin.source, name: origin.name } }),
  })

/** Only calls on a namespace or default import are uses of the module. */
export const bindingOfMember = (kind: SymbolKind, member: string): Binding | undefined =>
  Match.valueTags(kind, {
    Global: (): Binding | undefined => undefined,
    Local: (): Binding | undefined => undefined,
    Import: ({ origin }): Binding | undefined =>
      origin.namespace ? { _tag: "Imported", name: { source: origin.source, name: member } } : undefined,
  })
