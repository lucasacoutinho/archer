import { ChildProcess } from "node:child_process"
import type { API } from "typescript/unstable/async"

/**
 * TypeScript's async client never rejects a request to a server that has
 * died, so the adapter watches the server process itself. The client keeps
 * it in a private field; `test/analyzer/server-exit.test.ts` fails when that
 * changes.
 */
const serverProcess = (api: API): ChildProcess | undefined => {
  const client: unknown = Reflect.get(api, "client")
  const child: unknown = typeof client === "object" && client !== null ? Reflect.get(client, "process") : undefined
  return child instanceof ChildProcess ? child : undefined
}

const NEVER: Promise<void> = new Promise<void>(() => undefined)

/** Resolves when the server process has exited; never resolves when it cannot be found. */
export const serverExit = (api: API): Promise<void> => {
  const child = serverProcess(api)
  if (child === undefined) {
    return NEVER
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    child.once("exit", () => resolve())
  })
}

/**
 * Releases a client whose server has died without writing to it: `close()`
 * would first send a `release` request per snapshot, and a write to a dead
 * process fails with EPIPE outside any promise the adapter can observe.
 */
export const abandon = (api: API): void => {
  const client: unknown = Reflect.get(api, "client")
  const connection: unknown = typeof client === "object" && client !== null ? Reflect.get(client, "connection") : undefined
  if (typeof connection === "object" && connection !== null) {
    const dispose: unknown = Reflect.get(connection, "dispose")
    if (typeof dispose === "function") Reflect.apply(dispose, connection, [])
  }
  const child = serverProcess(api)
  child?.stdin?.destroy()
  child?.stdout?.destroy()
}
