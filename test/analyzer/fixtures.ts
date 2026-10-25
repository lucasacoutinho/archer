import { fileURLToPath } from "node:url"
import type { Workspace } from "../../src/analyzer/Analyzer.ts"

const root = (name: string): string => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))

export const fixtures = {
  project: { root: root("project"), projects: ["tsconfig.json"] },
  semantic: { root: root("semantic"), projects: ["tsconfig.json"] },
  imports: { root: root("imports"), projects: ["tsconfig.json"] },
  facts: { root: root("facts"), projects: ["tsconfig.json"] },
  workspace: { root: root("workspace"), projects: ["packages/core/tsconfig.json", "packages/app/tsconfig.json"] },
} as const satisfies Record<string, Workspace>
