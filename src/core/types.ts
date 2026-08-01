export type Selector = string | readonly string[]

export type DependencyKind = 'dynamic' | 'require' | 'static' | 'type'

export type DependencyResolution =
  | 'bun'
  | 'dynamic'
  | 'file'
  | 'local'
  | 'node'
  | 'npm'
  | 'unresolved'

export type RuleSeverity = 'error' | 'info' | 'warning'

export interface SourceLocation {
  readonly column: number
  readonly line: number
}

export interface Dependency extends SourceLocation {
  readonly external: boolean
  readonly from: string
  readonly kind: DependencyKind
  readonly packageName?: string
  readonly resolution: DependencyResolution
  readonly resolved: boolean
  readonly specifier: string
  readonly target: string
}

export type DeclarationKind = 'class' | 'enum' | 'function' | 'interface' | 'type' | 'variable'

export interface MethodInfo {
  readonly name: string
  readonly static: boolean
  readonly visibility: 'private' | 'protected' | 'public'
}

export interface DeclarationInfo extends SourceLocation {
  readonly abstract: boolean
  readonly decorators: readonly string[]
  readonly defaultExport: boolean
  readonly exported: boolean
  readonly extends: readonly string[]
  readonly implements: readonly string[]
  readonly kind: DeclarationKind
  readonly methods: readonly MethodInfo[]
  readonly name: string
  readonly readonlyProperties: boolean
}

export interface SourceUse extends SourceLocation {
  readonly kind: 'call' | 'loose-equality'
  readonly importedFrom?: string
  readonly importedName?: string
  readonly name: string
}

export interface SourceModule {
  readonly absolutePath: string
  readonly declarations: readonly DeclarationInfo[]
  readonly dependencies: readonly Dependency[]
  readonly exports: readonly string[]
  readonly lines: number
  readonly path: string
  readonly project?: string
  readonly sourceLines: readonly string[]
  readonly uses: readonly SourceUse[]
}

export interface ProjectInfo {
  readonly name: string
  readonly root: string
  readonly tsconfig: string
}

export interface ArchitectureGraph {
  readonly dependencies: readonly Dependency[]
  readonly modules: readonly SourceModule[]
  readonly projects: readonly ProjectInfo[]
  readonly root: string
}

export interface ArcherProjectOptions {
  /** Globs, relative to the project directory, that replace the global include list. */
  readonly include?: readonly string[]
  /** Path to a tsconfig file, relative to Archer's root. */
  readonly tsconfig: string
}

export interface ArcherOptions {
  /** Reuse graphs while source and project-configuration signatures remain unchanged. Defaults to true. */
  readonly cache?: boolean
  /** Globs, relative to root, for source files to analyze. */
  readonly include?: readonly string[]
  /** Include .d.ts files as selectable source modules. Defaults to false. */
  readonly includeTypeDeclarations?: boolean
  /** Globs, relative to root, that should not be analyzed. */
  readonly exclude?: readonly string[]
  /** Follow symlinks when identifying workspace files. Defaults to true. */
  readonly followSymlinks?: boolean
  /** Additional tsconfig projects or project-specific settings. */
  readonly projects?: readonly (ArcherProjectOptions | string)[]
  /** Project root. Defaults to process.cwd(). */
  readonly root?: string
  /** tsconfig used for module resolution. Set false to use TypeScript defaults. */
  readonly tsconfig?: string | false
  /** Discover package-workspace tsconfigs. Defaults to true. */
  readonly workspaces?: boolean
}

export interface ArchitectureViolation {
  readonly column?: number
  readonly dependency?: string
  readonly file?: string
  readonly importChain?: readonly string[]
  readonly line?: number
  readonly message: string
  readonly reason?: string
  readonly rule: string
  readonly ruleId?: string
  readonly severity: RuleSeverity
  readonly sourceLine?: string
}

export interface ArchitectureResult {
  readonly dependenciesAnalyzed: number
  readonly errors: number
  readonly filesAnalyzed: number
  readonly infos: number
  readonly ok: boolean
  readonly violations: readonly ArchitectureViolation[]
  readonly warnings: number
}

export interface CustomRuleContext {
  readonly graph: ArchitectureGraph
  readonly modules: readonly SourceModule[]
}

export type CustomRuleResult =
  | ArchitectureViolation
  | readonly ArchitectureViolation[]
  | undefined
  | void

export type CustomRule = (
  context: CustomRuleContext,
) => CustomRuleResult | Promise<CustomRuleResult>

export interface RuleMetadata {
  readonly id?: string
  readonly reason?: string
  readonly severity?: RuleSeverity
}
