import { NodeServices } from "@effect/platform-node"
import { describe, expect, it, layer } from "@effect/vitest"
import { Effect, Exit, FileSystem, Path } from "effect"
import type { Fingerprint } from "../../src/core/fingerprint.ts"
import { formatBaseline, parseBaseline, readBaseline, writeBaseline } from "../../src/shell/baseline-file.ts"

const entries: Array<Fingerprint> = [
  { ruleId: "no-infra", subject: ["src", "domain", "order.ts"], key: { _tag: "Missing" } },
  { ruleId: "a|b", subject: ["x"], key: { _tag: "Custom", message: "line\nbreak" } },
]

describe("baseline text", () => {
  it("starts with the header and holds one line per entry", () => {
    const text = formatBaseline(entries)
    expect(text.split("\n")).toEqual(["archer-baseline 1", expect.any(String), expect.any(String), ""])
  })

  it("reads back what it wrote", async () => {
    expect(await Effect.runPromise(parseBaseline("b", formatBaseline(entries)))).toEqual(entries)
  })

  it("rejects another header and a malformed line, naming the line", async () => {
    const header = await Effect.runPromiseExit(parseBaseline("b", "archer-baseline 2\n"))
    expect(Exit.isFailure(header) && JSON.stringify(header.cause)).toContain("UnsupportedHeader")
    const line = await Effect.runPromiseExit(parseBaseline("b", "archer-baseline 1\nnot a fingerprint\n"))
    expect(Exit.isFailure(line) && JSON.stringify(line.cause)).toContain('"line":2')
  })
})

layer(NodeServices.layer)("baseline files", (it) => {
  it.effect("treats a missing file as an empty baseline and round-trips a written one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "archer-baseline-" })
      const file = path.join(root, "nested", ".archer-baseline")
      expect(yield* readBaseline(file)).toEqual([])
      yield* writeBaseline(file, entries)
      expect(yield* readBaseline(file)).toEqual(entries)
      expect(yield* fs.readDirectory(path.join(root, "nested"))).toEqual([".archer-baseline"])
    }).pipe(Effect.scoped),
  )
})
