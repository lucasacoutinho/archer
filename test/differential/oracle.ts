import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const executable = fileURLToPath(new URL("../../lean/.lake/build/bin/archer-oracle", import.meta.url))

export type Request = { readonly op: string } & Record<string, unknown>

/** Runs a batch through the Lean oracle (docs/contracts/oracle.md). */
export const askOracle = (requests: ReadonlyArray<Request>): Array<unknown> => {
  if (!existsSync(executable)) {
    throw new Error(`Lean oracle not built at ${executable}; run \`cd lean && lake build archer-oracle\``)
  }
  const result = spawnSync(executable, { input: JSON.stringify(requests), maxBuffer: 1 << 28, encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(`Lean oracle failed (${result.status}): ${result.stderr}`)
  }
  return JSON.parse(result.stdout) as Array<unknown>
}
