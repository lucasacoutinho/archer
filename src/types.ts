export type Selector = string | readonly string[]

export type DependencyKind = 'dynamic' | 'require' | 'static' | 'type'

export interface Dependency {
  readonly column: number
  readonly from: string
  readonly kind: DependencyKind
  readonly line: number
  readonly specifier: string
  readonly target: string
}

export interface SourceModule {
  readonly absolutePath: string
  readonly dependencies: readonly Dependency[]
  readonly lines: number
  readonly path: string
}

export interface ArchitectureGraph {
  readonly dependencies: readonly Dependency[]
  readonly modules: readonly SourceModule[]
  readonly root: string
}

export interface ArcherOptions {
  /** Globs, relative to root, for source files to analyze. */
  readonly include?: readonly string[]
  /** Globs, relative to root, that should not be analyzed. */
  readonly exclude?: readonly string[]
  /** Project root. Defaults to process.cwd(). */
  readonly root?: string
  /** tsconfig used for module resolution. Set false to use TypeScript defaults. */
  readonly tsconfig?: string | false
}

export interface ArchitectureViolation {
  readonly column?: number
  readonly dependency?: string
  readonly file?: string
  readonly line?: number
  readonly message: string
  readonly rule: string
}

export interface ArchitectureResult {
  readonly dependenciesAnalyzed: number
  readonly filesAnalyzed: number
  readonly ok: boolean
  readonly violations: readonly ArchitectureViolation[]
}
