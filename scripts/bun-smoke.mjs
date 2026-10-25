import { fileURLToPath } from "node:url"
import { ArchitectureError, assertArchitecture, defineConfig, dispose } from "../src/index.ts"

const fixture = fileURLToPath(new URL("../test/fixtures/project", import.meta.url))

const config = defineConfig({
  layers: { application: "src/application", domain: "src/domain", infrastructure: "src/infrastructure" },
  stack: ["application", "domain"],
  baseline: false,
})

const failure = await assertArchitecture({ config, cwd: fixture }).then(
  () => undefined,
  (error) => error,
)
await dispose()

if (!(failure instanceof ArchitectureError)) {
  console.error("bun smoke failed: expected ArchitectureError, got", failure)
  process.exit(1)
}
console.log("bun smoke passed")
process.exit(0)
