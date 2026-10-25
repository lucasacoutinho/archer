import { ChildProcess } from "node:child_process"
import type { API } from "typescript/unstable/async"

const NEVER: Promise<void> = new Promise<void>(() => undefined)

/**
 * A request in flight when the server dies is never answered, so the client alone
 * cannot report it. The client keeps its child process in a private field; this
 * resolves when that process has ended and its streams are closed, and never
 * resolves when the process cannot be found.
 */
export const serverExit = (api: API): Promise<void> => {
  const client: unknown = Reflect.get(api, "client")
  const child: unknown = typeof client === "object" && client !== null ? Reflect.get(client, "process") : undefined
  if (!(child instanceof ChildProcess)) {
    return NEVER
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    child.once("close", () => resolve())
  })
}
