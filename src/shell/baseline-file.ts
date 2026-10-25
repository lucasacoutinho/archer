import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { decode, encode, type Fingerprint } from "../core/fingerprint.ts"

export const header: string = "archer-baseline 1"

export class BaselineError extends Schema.TaggedError<BaselineError, { readonly brand: unique symbol }>()("BaselineError", {
  path: Schema.String,
  reason: Schema.Literals(["Unreadable", "UnsupportedHeader", "MalformedLine", "Unwritable"]),
  line: Schema.optionalKey(Schema.Int),
}) {}

export const parseBaseline = (path: string, text: string): Effect.Effect<Array<Fingerprint>, BaselineError> => {
  const [first, ...rest] = text.split("\n")
  if (first !== header) {
    return Effect.fail(new BaselineError({ path, reason: "UnsupportedHeader", line: 1 }))
  }
  const entries: Array<Fingerprint> = []
  for (const [index, line] of rest.entries()) {
    if (line === "") {
      continue
    }
    const entry = decode(line)
    if (Option.isNone(entry)) {
      return Effect.fail(new BaselineError({ path, reason: "MalformedLine", line: index + 2 }))
    }
    entries.push(entry.value)
  }
  return Effect.succeed(entries)
}

export const formatBaseline = (entries: ReadonlyArray<Fingerprint>): string =>
  [header, ...entries.map(encode)].join("\n") + "\n"

/** A missing file is an empty baseline, so a project can adopt Archer before recording one. */
export const readBaseline: (
  path: string,
) => Effect.Effect<Array<Fingerprint>, BaselineError, FileSystem.FileSystem> = Effect.fn("readBaseline")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const exists = yield* fs.exists(path).pipe(Effect.mapError(() => new BaselineError({ path, reason: "Unreadable" })))
  if (!exists) {
    return []
  }
  const text = yield* fs.readFileString(path).pipe(Effect.mapError(() => new BaselineError({ path, reason: "Unreadable" })))
  return yield* parseBaseline(path, text)
})

/** Writes through a sibling temporary file and a rename, so a reader never sees half a baseline. */
export const writeBaseline: (
  path: string,
  entries: ReadonlyArray<Fingerprint>,
) => Effect.Effect<void, BaselineError, FileSystem.FileSystem | Path.Path> = Effect.fn("writeBaseline")(function* (path: string, entries: ReadonlyArray<Fingerprint>) {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  const temporary = paths.join(paths.dirname(path), `.${paths.basename(path)}.tmp`)
  yield* fs.makeDirectory(paths.dirname(path), { recursive: true }).pipe(
    Effect.andThen(fs.writeFileString(temporary, formatBaseline(entries))),
    Effect.andThen(fs.rename(temporary, path)),
    Effect.mapError(() => new BaselineError({ path, reason: "Unwritable" })),
  )
})
