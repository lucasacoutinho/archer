/**
 * Port of lean/Archer/Fingerprint.lean and the encoding in lean/Archer/Impl/Baseline.lean
 * (grammar documented there). Escapes are ASCII, so working on UTF-16 units equals Lean's
 * character-wise processing.
 */
import { Match, Option, Schema } from "effect"
import { DependencyKind, FilePath, Binding, Target, UseKind } from "./model.ts"
import { type EvidenceKey, type Violation, evidenceKey } from "./rule.ts"
import type { Runtime } from "./model.ts"

export type FingerprintKey =
  | { readonly _tag: "Target"; readonly target: Target }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Cycle" }
  | {
      readonly _tag: "Dependency"
      readonly target: Target
      readonly specifier: string
      readonly kind: DependencyKind
    }
  | { readonly _tag: "Declaration"; readonly name: string }
  | { readonly _tag: "Export"; readonly name: string }
  | { readonly _tag: "Use"; readonly kind: UseKind; readonly name: string; readonly binding: Binding }
  | { readonly _tag: "Name" }
  | { readonly _tag: "Lines" }
  | { readonly _tag: "Custom"; readonly message: string }

export const FingerprintKey: Schema.Codec<FingerprintKey> = Schema.Union([
  Schema.TaggedStruct("Target", { target: Target }),
  Schema.TaggedStruct("Missing", {}),
  Schema.TaggedStruct("Cycle", {}),
  Schema.TaggedStruct("Dependency", { target: Target, specifier: Schema.String, kind: DependencyKind }),
  Schema.TaggedStruct("Declaration", { name: Schema.String }),
  Schema.TaggedStruct("Export", { name: Schema.String }),
  Schema.TaggedStruct("Use", { kind: UseKind, name: Schema.String, binding: Binding }),
  Schema.TaggedStruct("Name", {}),
  Schema.TaggedStruct("Lines", {}),
  Schema.TaggedStruct("Custom", { message: Schema.String }),
])
export interface Fingerprint {
  readonly ruleId: string
  readonly subject: FilePath
  readonly key: FingerprintKey
}

export const Fingerprint: Schema.Codec<Fingerprint> = Schema.Struct({
  ruleId: Schema.String,
  subject: FilePath,
  key: FingerprintKey,
})

/** Lean `EvidenceKey.stable`: drops locations. */
export const stable = (key: EvidenceKey): FingerprintKey =>
  Match.valueTags(key, {
    Target: ({ target }): FingerprintKey => ({ _tag: "Target", target }),
    Missing: (): FingerprintKey => ({ _tag: "Missing" }),
    Cycle: (): FingerprintKey => ({ _tag: "Cycle" }),
    Dependency: ({ edge }): FingerprintKey => ({
      _tag: "Dependency",
      target: edge.dependency.target,
      specifier: edge.dependency.specifier,
      kind: edge.dependency.kind,
    }),
    Declaration: ({ name }): FingerprintKey => ({ _tag: "Declaration", name }),
    Export: ({ name }): FingerprintKey => ({ _tag: "Export", name }),
    Use: ({ use }): FingerprintKey => ({ _tag: "Use", kind: use.kind, name: use.name, binding: use.binding }),
    Name: (): FingerprintKey => ({ _tag: "Name" }),
    Lines: (): FingerprintKey => ({ _tag: "Lines" }),
    Custom: ({ message }): FingerprintKey => ({ _tag: "Custom", message }),
  })

export const fingerprint = (violation: Violation): Fingerprint => ({
  ruleId: violation.ruleId,
  subject: violation.subject,
  key: stable(evidenceKey(violation.evidence)),
})

interface Level {
  readonly separator: string
  readonly escapeLetter: string
}

const fieldLevel: Level = { separator: "|", escapeLetter: "p" }
const pathLevel: Level = { separator: "/", escapeLetter: "s" }

const escape = (level: Level, text: string): string =>
  Array.from(text, (char) =>
    Match.value(char).pipe(
      Match.when("\\", () => "\\\\"),
      Match.when(level.separator, () => `\\${level.escapeLetter}`),
      Match.when("\n", () => "\\n"),
      Match.when("\r", () => "\\r"),
      Match.orElse(() => char),
    ),
  ).join("")

const unescapeChar = (level: Level, char: string): string | undefined =>
  Match.value(char).pipe(
    Match.when("\\", () => "\\"),
    Match.when(level.escapeLetter, () => level.separator),
    Match.when("n", () => "\n"),
    Match.when("r", () => "\r"),
    Match.orElse(() => undefined),
  )

/** Undoes `escape`; `undefined` on a backslash sequence that `escape` never writes or a trailing backslash. */
const unescape = (level: Level, text: string): string | undefined => {
  let out = ""
  let pending = false
  for (const char of text) {
    if (pending) {
      const decoded = unescapeChar(level, char)
      if (decoded === undefined) return undefined
      out += decoded
      pending = false
    } else if (char === "\\") {
      pending = true
    } else {
      out += char
    }
  }
  return pending ? undefined : out
}

const unescapeAll = (level: Level, texts: ReadonlyArray<string>): Array<string> | undefined => {
  const out: Array<string> = []
  for (const text of texts) {
    const decoded = unescape(level, text)
    if (decoded === undefined) return undefined
    out.push(decoded)
  }
  return out
}

const encodeSeq = (level: Level, texts: ReadonlyArray<string>): string =>
  texts.map((text) => level.separator + escape(level, text)).join("")

const decodeSeq = (level: Level, text: string): Array<string> | undefined => {
  const [head, ...rest] = text.split(level.separator)
  return head === "" ? unescapeAll(level, rest) : undefined
}

const encodeFields = (level: Level, [first, ...rest]: readonly [string, ...Array<string>]): string =>
  escape(level, first) + encodeSeq(level, rest)

const decodeFields = (level: Level, text: string): Array<string> | undefined => {
  const [head = "", ...rest] = text.split(level.separator)
  const first = unescape(level, head)
  const others = unescapeAll(level, rest)
  return first === undefined || others === undefined ? undefined : [first, ...others]
}

const pathText = (path: ReadonlyArray<string>): string => encodeSeq(pathLevel, path)

const parsePath = (text: string): Array<string> | undefined => decodeSeq(pathLevel, text)

const parseRuntime = (word: string): Runtime | undefined =>
  Match.value(word).pipe(
    Match.when("node", () => "node" as const),
    Match.when("bun", () => "bun" as const),
    Match.orElse(() => undefined),
  )

const parseDependencyKind = (word: string): DependencyKind | undefined =>
  Match.value(word).pipe(
    Match.when("static", () => "static" as const),
    Match.when("type", () => "type" as const),
    Match.when("require", () => "require" as const),
    Match.when("dynamic", () => "dynamic" as const),
    Match.orElse(() => undefined),
  )

const parseUseKind = (word: string): UseKind | undefined =>
  Match.value(word).pipe(
    Match.when("call", () => "call" as const),
    Match.when("looseEquality", () => "looseEquality" as const),
    Match.orElse(() => undefined),
  )

const targetFields = (target: Target): Array<string> =>
  Match.valueTags(target, {
    File: ({ path }) => ["file", pathText(path)],
    Package: ({ name, subpath }) => ["package", name, pathText(subpath)],
    Builtin: ({ runtime, name }) => ["builtin", runtime, name],
    Unresolved: ({ specifier }) => ["unresolved", specifier],
    Computed: () => ["computed"],
  })

/** Reads exactly the fields of one target. */
const parseTarget = ([tag, ...args]: ReadonlyArray<string>): Target | undefined => {
  const [a, b] = args
  return Match.value(tag).pipe(
    Match.when("file", () => {
      const path = args.length === 1 && a !== undefined ? parsePath(a) : undefined
      return path === undefined ? undefined : ({ _tag: "File", path } as const)
    }),
    Match.when("package", () => {
      const subpath = args.length === 2 && b !== undefined ? parsePath(b) : undefined
      return subpath === undefined || a === undefined ? undefined : ({ _tag: "Package", name: a, subpath } as const)
    }),
    Match.when("builtin", () => {
      const runtime = args.length === 2 && a !== undefined ? parseRuntime(a) : undefined
      return runtime === undefined || b === undefined ? undefined : ({ _tag: "Builtin", runtime, name: b } as const)
    }),
    Match.when("unresolved", () =>
      args.length === 1 && a !== undefined ? ({ _tag: "Unresolved", specifier: a } as const) : undefined,
    ),
    Match.when("computed", () => (args.length === 0 ? ({ _tag: "Computed" } as const) : undefined)),
    Match.orElse(() => undefined),
  )
}

const bindingFields = (binding: Binding): Array<string> =>
  Match.valueTags(binding, {
    Global: () => ["global"],
    Local: () => ["local"],
    Imported: ({ name }) => ["imported", name.source, name.name],
  })

const parseBinding = ([tag, ...args]: ReadonlyArray<string>): Binding | undefined => {
  const [source, name] = args
  return Match.value(tag).pipe(
    Match.when("global", () => (args.length === 0 ? ({ _tag: "Global" } as const) : undefined)),
    Match.when("local", () => (args.length === 0 ? ({ _tag: "Local" } as const) : undefined)),
    Match.when("imported", () =>
      args.length === 2 && source !== undefined && name !== undefined
        ? ({ _tag: "Imported", name: { source, name } } as const)
        : undefined,
    ),
    Match.orElse(() => undefined),
  )
}

const keyFields = (key: FingerprintKey): Array<string> =>
  Match.valueTags(key, {
    Target: ({ target }) => ["target", ...targetFields(target)],
    Missing: () => ["missing"],
    Cycle: () => ["cycle"],
    Dependency: ({ target, specifier, kind }) => ["dependency", kind, specifier, ...targetFields(target)],
    Declaration: ({ name }) => ["declaration", name],
    Export: ({ name }) => ["export", name],
    Use: ({ kind, name, binding }) => ["use", kind, name, ...bindingFields(binding)],
    Name: () => ["name"],
    Lines: () => ["lines"],
    Custom: ({ message }) => ["custom", message],
  })

const parseKey = ([tag, ...args]: ReadonlyArray<string>): FingerprintKey | undefined => {
  const [first, second, ...more] = args
  return Match.value(tag).pipe(
    Match.when("target", () => {
      const target = parseTarget(args)
      return target === undefined ? undefined : ({ _tag: "Target", target } as const)
    }),
    Match.when("missing", () => (args.length === 0 ? ({ _tag: "Missing" } as const) : undefined)),
    Match.when("cycle", () => (args.length === 0 ? ({ _tag: "Cycle" } as const) : undefined)),
    Match.when("dependency", () => {
      if (first === undefined || second === undefined) return undefined
      const kind = parseDependencyKind(first)
      const target = parseTarget(more)
      return kind === undefined || target === undefined
        ? undefined
        : ({ _tag: "Dependency", target, specifier: second, kind } as const)
    }),
    Match.when("declaration", () =>
      args.length === 1 && first !== undefined ? ({ _tag: "Declaration", name: first } as const) : undefined,
    ),
    Match.when("export", () =>
      args.length === 1 && first !== undefined ? ({ _tag: "Export", name: first } as const) : undefined,
    ),
    Match.when("use", () => {
      if (first === undefined || second === undefined) return undefined
      const kind = parseUseKind(first)
      const binding = parseBinding(more)
      return kind === undefined || binding === undefined
        ? undefined
        : ({ _tag: "Use", kind, name: second, binding } as const)
    }),
    Match.when("name", () => (args.length === 0 ? ({ _tag: "Name" } as const) : undefined)),
    Match.when("lines", () => (args.length === 0 ? ({ _tag: "Lines" } as const) : undefined)),
    Match.when("custom", () =>
      args.length === 1 && first !== undefined ? ({ _tag: "Custom", message: first } as const) : undefined,
    ),
    Match.orElse(() => undefined),
  )
}

/** One line: the rule ID, the subject path, then the key. */
export const encode = (fingerprint: Fingerprint): string =>
  encodeFields(fieldLevel, [fingerprint.ruleId, pathText(fingerprint.subject), ...keyFields(fingerprint.key)])

/** A strict parser; `None` when the line is not an encoding. */
export const decode = (line: string): Option.Option<Fingerprint> => {
  const fields = decodeFields(fieldLevel, line)
  if (fields === undefined) return Option.none()
  const [ruleId, subjectText, ...keyText] = fields
  if (ruleId === undefined || subjectText === undefined) return Option.none()
  const subject = parsePath(subjectText)
  const key = parseKey(keyText)
  return subject === undefined || key === undefined ? Option.none() : Option.some({ ruleId, subject, key })
}

