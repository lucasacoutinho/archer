import { API } from "typescript/unstable/async"
import { describe, expect, it } from "vitest"
import { serverExit } from "../../src/analyzer/server-exit.ts"

describe("serverExit", () => {
  it("sees the TypeScript server process end, so a dead server cannot hang a check", async () => {
    const api = new API({ cwd: process.cwd() })
    await api.updateSnapshot({ openProjects: [] })
    const exited = serverExit(api)
    await api.close()
    const outcome = await Promise.race([
      exited.then(() => "exited"),
      new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 10_000)),
    ])
    expect(outcome, "the TypeScript client no longer keeps its process where serverExit looks").toBe("exited")
  }, 20_000)
})
