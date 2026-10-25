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

/**
 * vscode-jsonrpc, bundled in TypeScript, runs `sendRequest` in an async
 * Promise executor that rethrows a failed write after rejecting the request.
 * The rethrow rejects a promise nobody holds, so a write to a server that has
 * just died becomes an unhandled rejection. A failed write means the server is
 * gone, and `serverExit` already fails the request, so the write's error is
 * not passed back to the library.
 */
export const muteFailedWrites = (api: API): void => {
  const stdin = serverProcess(api)?.stdin
  if (stdin === undefined || stdin === null) return
  const write: unknown = Reflect.get(stdin, "write")
  if (typeof write !== "function") return
  Reflect.set(stdin, "write", (...args: Array<unknown>): unknown => {
    const last = args.at(-1)
    if (typeof last === "function") {
      args[args.length - 1] = (error: unknown): void => {
        if (error === undefined || error === null) Reflect.apply(last, undefined, [])
      }
    }
    return Reflect.apply(write, stdin, args)
  })
}
