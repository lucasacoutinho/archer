import { fileURLToPath } from "node:url"
import { afterAll, expect, it } from "vitest"
import { assertArchitecture, dispose } from "../src/index.ts"

afterAll(dispose)

it("Archer respects its own architecture", async () => {
  const report = await assertArchitecture({ cwd: fileURLToPath(new URL("..", import.meta.url)) })
  expect(report.emptySubjects).toEqual([])
}, 60_000)
