import { NodeServices } from "@effect/platform-node"
import { expect, layer } from "@effect/vitest"
import { Effect, Exit, FileSystem, Path } from "effect"
import { importConfig } from "../../src/shell/load-config.ts"

const writeProject = (packageJson: object, files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "archer-config-" })
    yield* fs.writeFileString(path.join(root, "package.json"), JSON.stringify(packageJson))
    for (const [name, text] of Object.entries(files)) {
      yield* fs.writeFileString(path.join(root, name), text)
    }
    return { root, file: (name: string) => path.join(root, name) }
  })

const config = `import { layers } from "./layers.ts"\nexport default { layers, answer: 42 }\n`
const sibling = `export const layers: Record<string, string> = { app: "src/app" }\n`

layer(NodeServices.layer)("configuration modules", (it) => {
  for (const [label, packageJson] of [
    ["an ES module package", { type: "module" }],
    ["a package without a type field", {}],
  ] as const) {
    it.effect(`loads a TypeScript config with a sibling .ts import in ${label}`, () =>
      Effect.gen(function* () {
        const project = yield* writeProject(packageJson, { "archer.config.ts": config, "layers.ts": sibling })
        expect(yield* importConfig(project.file("archer.config.ts"))).toEqual({ layers: { app: "src/app" }, answer: 42 })
      }).pipe(Effect.scoped),
    )
  }

  it.effect("loads a fresh module each time, so edits are seen", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const project = yield* writeProject({ type: "module" }, { "archer.config.ts": "export default 1\n" })
      expect(yield* importConfig(project.file("archer.config.ts"))).toBe(1)
      yield* fs.writeFileString(project.file("archer.config.ts"), "export default 2\n")
      expect(yield* importConfig(project.file("archer.config.ts"))).toBe(2)
    }).pipe(Effect.scoped),
  )

  it.effect("fails with ConfigLoadError for a missing or broken module", () =>
    Effect.gen(function* () {
      const project = yield* writeProject({ type: "module" }, { "archer.config.ts": "export default {\n" })
      const broken = yield* Effect.exit(importConfig(project.file("archer.config.ts")))
      const missing = yield* Effect.exit(importConfig(project.file("absent.ts")))
      expect([Exit.isFailure(broken), Exit.isFailure(missing)]).toEqual([true, true])
    }).pipe(Effect.scoped),
  )
})
