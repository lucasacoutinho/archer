import { ChildProcess } from "node:child_process"
import { API } from "typescript/unstable/async"
import { describe, expect, it } from "vitest"
import { muteFailedWrites, serverExit } from "../../src/analyzer/server-exit.ts"

const serverOf = (api: API): ChildProcess => {
  const child: unknown = Reflect.get(Reflect.get(api, "client"), "process")
  if (!(child instanceof ChildProcess)) throw new Error("the TypeScript client no longer keeps its process where server-exit.ts looks")
  return child
}

describe("server exit", () => {
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

  it("leaves no unhandled rejection when a request is written to a server that just died", async () => {
    const api = new API({ cwd: process.cwd() })
    await api.updateSnapshot({ openProjects: [] })
    muteFailedWrites(api)
    const leaks: Array<unknown> = []
    const listener = (reason: unknown): void => {
      leaks.push(reason)
    }
    process.on("unhandledRejection", listener)
    try {
      serverOf(api).kill("SIGKILL")
      // Let the process die before Node handles its exit, the window a slow machine opens.
      const until = Date.now() + 300
      while (Date.now() < until) {}
      void api.updateSnapshot({ openProjects: [] }).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    } finally {
      process.off("unhandledRejection", listener)
    }
    expect(leaks).toEqual([])
  }, 20_000)
})
