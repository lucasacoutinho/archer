import { Match } from "effect"
import type { Project } from "typescript/unstable/async"
import { SyntaxKind, type SourceFile } from "typescript/unstable/ast"
import type { Declaration, DependencyKind, Location, Use } from "../core/model.ts"
import { bindingOfMember, bindingOfName, classifySymbol, type SymbolKind } from "./bindings.ts"
import { compareCodeUnits } from "./paths.ts"
import { countLines, declarationsOf, locationOf, scanSource } from "./syntax.ts"

export type Resolution =
  | { readonly _tag: "Computed" }
  | { readonly _tag: "Module"; readonly path: string; readonly isFile: boolean }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Unchecked" }

export interface RawDependency {
  readonly kind: DependencyKind
  readonly specifier: string
  readonly location: Location
  readonly resolution: Resolution
}

export interface RawSource {
  readonly dependencies: ReadonlyArray<RawDependency>
  readonly declarations: ReadonlyArray<Declaration>
  readonly exports: ReadonlyArray<string>
  readonly uses: ReadonlyArray<Use>
  readonly lines: number
}

const byLocation = (left: { readonly location: Location }, right: { readonly location: Location }): number =>
  left.location.line - right.location.line || left.location.column - right.location.column

const compareUses = (left: Use, right: Use): number =>
  byLocation(left, right) || compareCodeUnits(left.kind, right.kind) || compareCodeUnits(left.name, right.name)

const compareDependencies = (left: RawDependency, right: RawDependency): number =>
  byLocation(left, right) || compareCodeUnits(left.specifier, right.specifier) || compareCodeUnits(left.kind, right.kind)

export const readSource = async (project: Project, sourceFile: SourceFile): Promise<RawSource> => {
  const scan = scanSource(sourceFile)
  const checkable = scan.sites.filter((site) => site.checkable)
  const isModule = sourceFile.externalModuleIndicator !== undefined

  // One checker request per file: specifier literals, then callee roots, then the file itself.
  const nodes = [...checkable.map((site) => site.node), ...scan.calls.map((call) => call.root), ...(isModule ? [sourceFile] : [])]
  const symbols = nodes.length === 0 ? [] : await project.checker.getSymbolAtLocation(nodes)
  const moduleSymbols = new Map(checkable.map((site, index) => [site, symbols[index]] as const))
  const callSymbols = symbols.slice(checkable.length, checkable.length + scan.calls.length)
  const fileSymbol = isModule ? symbols[nodes.length - 1] : undefined

  const dependencies = scan.sites
    .map((site): RawDependency => {
      const symbol = moduleSymbols.get(site)
      const declaration = symbol?.declarations.find((candidate) => candidate.kind === SyntaxKind.SourceFile) ?? symbol?.declarations[0]
      const resolution = Match.value(site).pipe(
        Match.when({ computed: true }, (): Resolution => ({ _tag: "Computed" })),
        Match.when({ checkable: false }, (): Resolution => ({ _tag: "Unchecked" })),
        Match.orElse(
          (): Resolution =>
            declaration === undefined
              ? { _tag: "Missing" }
              : { _tag: "Module", path: declaration.path, isFile: declaration.kind === SyntaxKind.SourceFile },
        ),
      )
      return { kind: site.kind, specifier: site.specifier, location: locationOf(sourceFile, site.node), resolution }
    })
    .toSorted(compareDependencies)

  const kinds = new Map<number, Promise<SymbolKind>>()
  const kindOf = (index: number): Promise<SymbolKind> => {
    const symbol = callSymbols[index]
    const cached = symbol === undefined ? undefined : kinds.get(symbol.id)
    const kind = cached ?? classifySymbol(project, sourceFile.path, symbol)
    if (symbol !== undefined) {
      kinds.set(symbol.id, kind)
    }
    return kind
  }

  const [callKinds, exportSymbols] = await Promise.all([
    Promise.all(scan.calls.map((_, index) => kindOf(index))),
    fileSymbol === undefined ? Promise.resolve([]) : project.checker.getExportsOfModule(fileSymbol),
  ])

  const calls = scan.calls.flatMap((call, index): ReadonlyArray<Use> => {
    const kind = callKinds[index]
    const binding = kind === undefined ? undefined : call.member === undefined ? bindingOfName(kind) : bindingOfMember(kind, call.member)
    return binding === undefined ? [] : [{ kind: "call", name: call.name, binding, location: locationOf(sourceFile, call.callee) }]
  })
  const equalities = scan.looseEqualities.map(
    (token): Use => ({ kind: "looseEquality", name: token.getText(sourceFile), binding: { _tag: "Local" }, location: locationOf(sourceFile, token) }),
  )

  const exports = [...new Set(exportSymbols.map((symbol) => symbol.name))].toSorted(compareCodeUnits)

  return {
    dependencies,
    declarations: declarationsOf(sourceFile),
    exports,
    uses: [...calls, ...equalities].toSorted(compareUses),
    lines: countLines(sourceFile.text),
  }
}
