import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { Effect, Schema } from "effect"

export class ConfigLoadError extends Schema.TaggedError<ConfigLoadError, { readonly brand: unique symbol }>()(
  "ConfigLoadError",
  { path: Schema.String, cause: Schema.Defect() },
) {}

export const configFileNames: ReadonlyArray<string> = ["archer.config.ts", "archer.config.mts", "archer.config.js", "archer.config.mjs"]

interface Loaded {
  readonly source: string
  readonly value: unknown
}

let generation: number = 0

const loaded: Map<string, Loaded> = new Map<string, Loaded>()

/**
 * A changed configuration file loads as a new module instance, so a watcher
 * sees its edits. Node never frees a module instance, so an unchanged file
 * reuses the last one instead of leaking a copy per call. Modules the
 * configuration imports stay cached by Node.
 */
export const importConfig = (absolutePath: string): Effect.Effect<unknown, ConfigLoadError> =>
  Effect.tryPromise({
    try: async (): Promise<unknown> => {
      const source = await readFile(absolutePath, "utf8")
      const previous = loaded.get(absolutePath)
      if (previous !== undefined && previous.source === source) {
        return previous.value
      }
      generation += 1
      const url = new URL(pathToFileURL(absolutePath))
      url.searchParams.set("archer", String(generation))
      const module: { readonly default?: unknown } = await import(url.href)
      loaded.set(absolutePath, { source, value: module.default })
      return module.default
    },
    catch: (cause: unknown): ConfigLoadError => new ConfigLoadError({ path: absolutePath, cause }),
  })
