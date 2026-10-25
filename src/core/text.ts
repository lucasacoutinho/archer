/** Port of lean/Archer/Impl/Text.lean; the algorithm and its error order follow the Lean definitions. */
import { Array as Arr, Effect, Match, Option, Result, Schema, SchemaIssue, SchemaTransformation } from "effect"
import { ConfigSelector } from "./config.ts"
import type { PathToken, SegmentToken, Selector } from "./model.ts"

const Char: Schema.Codec<string> = Schema.String.check(Schema.isBetweenCodePoints(1, 1))

export type ParseError =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "InvalidName"; readonly kind: string; readonly name: string }
  | { readonly _tag: "InvalidSegment"; readonly text: string }
  | { readonly _tag: "Unsupported"; readonly char: string }
  | { readonly _tag: "UnbalancedBraces" }

export const ParseError: Schema.Codec<ParseError> = Schema.Union([
  Schema.TaggedStruct("Empty", {}),
  /** `kind` is the prefix without its colon. */
  Schema.TaggedStruct("InvalidName", { kind: Schema.String, name: Schema.String }),
  Schema.TaggedStruct("InvalidSegment", { text: Schema.String }),
  Schema.TaggedStruct("Unsupported", { char: Char }),
  Schema.TaggedStruct("UnbalancedBraces", {}),
])

/** Lean `List Char`: one string per code point. */
type Chars = ReadonlyArray<string>

const text = (chars: Chars): string => chars.join("")

/** The alternatives of the current group, and the groups it sits in (innermost last). */
interface Scan {
  readonly current: ReadonlyArray<Chars>
  readonly open: ReadonlyArray<{ readonly before: ReadonlyArray<Chars>; readonly done: ReadonlyArray<Chars> }>
}

const unbalanced: ParseError = { _tag: "UnbalancedBraces" }

const scanStep = (scan: Scan, char: string): Result.Result<Scan, ParseError> => {
  const group = scan.open.at(-1)
  const outer = scan.open.slice(0, -1)
  return Match.value(char).pipe(
    Match.when("{", () =>
      Result.succeed<Scan>({ current: [[]], open: [...scan.open, { before: scan.current, done: [] }] }),
    ),
    Match.when(",", () =>
      group === undefined
        ? Result.fail(unbalanced)
        : Result.succeed<Scan>({
            current: [[]],
            open: [...outer, { before: group.before, done: [...group.done, ...scan.current] }],
          }),
    ),
    Match.when("}", () =>
      group === undefined
        ? Result.fail(unbalanced)
        : Result.succeed<Scan>({
            current: group.before.flatMap((head) =>
              [...group.done, ...scan.current].map((tail): Chars => [...head, ...tail]),
            ),
            open: outer,
          }),
    ),
    Match.orElse(() =>
      Result.succeed<Scan>({ current: scan.current.map((alt): Chars => [...alt, char]), open: scan.open }),
    ),
  )
}

/** Brace expansion into brace-free alternatives, nested groups flattened in left-major order. */
const expand = (chars: Chars): Result.Result<ReadonlyArray<Chars>, ParseError> =>
  Result.flatMap(
    chars.reduce(
      (scan: Result.Result<Scan, ParseError>, char) => Result.flatMap(scan, (state) => scanStep(state, char)),
      Result.succeed<Scan>({ current: [[]], open: [] }),
    ),
    (scan) => (scan.open.length === 0 ? Result.succeed(scan.current) : Result.fail(unbalanced)),
  )

type Prefix = "npm:" | "node:" | "bun:" | "layer:" | "unresolved:" | "computed:"
const prefixes: ReadonlyArray<Prefix> = ["npm:", "node:", "bun:", "layer:", "unresolved:", "computed:"]

/** The first entry of `prefixes` that the alternative starts with, and the rest. */
const prefixOf = (alt: Chars): Option.Option<readonly [Prefix, Chars]> =>
  Arr.findFirst(prefixes, (prefix) => {
    const head = Array.from(prefix)
    return head.every((char, index) => alt[index] === char)
      ? Option.some([prefix, alt.slice(head.length)] as const)
      : Option.none()
  })

const unsupportedChars: Chars = ["\\", "[", "]"]

const dropLeadingDotSlash = (alt: Chars): Chars => (alt[0] === "." && alt[1] === "/" ? alt.slice(2) : alt)

const isInvalidSegment = (segment: string): boolean => segment === "" || segment === "." || segment === ".."

const isWild = (chars: Chars): boolean => chars.some((char) => char === "*" || char === "?")

const segmentToken = (char: string): SegmentToken =>
  Match.value(char).pipe(
    Match.when("*", (): SegmentToken => ({ _tag: "Star" })),
    Match.when("?", (): SegmentToken => ({ _tag: "One" })),
    Match.orElse((literal): SegmentToken => ({ _tag: "Literal", char: literal })),
  )

/** `**` as a whole segment is a globstar; `*` and `?` elsewhere are wildcards. */
const globToken = (segment: string): PathToken =>
  segment === "**" ? { _tag: "Globstar" } : { _tag: "Segment", tokens: Array.from(segment, segmentToken) }

const base = (selector: Selector): ConfigSelector => ({ _tag: "Base", selector })

const failOnSome = <A>(found: Option.Option<A>, error: (value: A) => ParseError): Result.Result<void, ParseError> =>
  Option.match(found, { onNone: () => Result.void, onSome: (value) => Result.fail(error(value)) })

/** Errors in this order: the first unsupported character, then the first invalid segment. */
const parsePath = (alt: Chars): Result.Result<ConfigSelector, ParseError> =>
  Result.gen(function* () {
    yield* failOnSome(
      Arr.findFirst(alt, (char) => unsupportedChars.includes(char)),
      (char): ParseError => ({ _tag: "Unsupported", char }),
    )
    const body = dropLeadingDotSlash(alt)
    // "/" is one UTF-16 unit, so splitting the joined text is splitting the code points.
    const segments = text(body).split("/")
    yield* failOnSome(Arr.findFirst(segments, isInvalidSegment), (segment): ParseError => ({
      _tag: "InvalidSegment",
      text: segment,
    }))
    const tokens = segments.map(globToken)
    return base({ _tag: "Glob", tokens: isWild(body) ? tokens : [...tokens, { _tag: "Globstar" }] })
  })

const isStar = (rest: Chars): boolean => rest.length === 1 && rest[0] === "*"

/** `name` or `@scope/name`, with non-empty parts and no other `/`. `@scope` alone is a plain name. */
const validPackage = (rest: Chars): boolean => {
  const slash = rest.indexOf("/")
  const scope = rest.slice(0, slash)
  const name = rest.slice(slash + 1)
  return (
    rest.length > 0 &&
    (slash < 0 || (scope[0] === "@" && scope.length >= 2 && name.length > 0 && !name.includes("/")))
  )
}

const invalidName = (kind: string, rest: Chars): Result.Result<never, ParseError> =>
  Result.fail({ _tag: "InvalidName", kind, name: text(rest) })

const builtin = (runtime: "node" | "bun", rest: Chars): Result.Result<ConfigSelector, ParseError> =>
  isStar(rest)
    ? Result.succeed(base({ _tag: "Builtin", runtime }))
    : rest.length === 0
      ? invalidName(runtime, rest)
      : Result.succeed(base({ _tag: "Builtin", runtime, name: text(rest) }))

const parsePrefixed = (prefix: Prefix, rest: Chars): Result.Result<ConfigSelector, ParseError> =>
  Match.value(prefix).pipe(
    Match.when("npm:", () =>
      isStar(rest)
        ? Result.succeed(base({ _tag: "Package" }))
        : validPackage(rest)
          ? Result.succeed(base({ _tag: "Package", name: text(rest) }))
          : invalidName("npm", rest),
    ),
    Match.when("node:", () => builtin("node", rest)),
    Match.when("bun:", () => builtin("bun", rest)),
    Match.when("layer:", () =>
      rest.length === 0
        ? invalidName("layer", rest)
        : Result.succeed<ConfigSelector>({ _tag: "Layer", name: text(rest) }),
    ),
    Match.when("unresolved:", () =>
      isStar(rest) ? Result.succeed(base({ _tag: "Unresolved" })) : invalidName("unresolved", rest),
    ),
    Match.when("computed:", () =>
      isStar(rest) ? Result.succeed(base({ _tag: "Computed" })) : invalidName("computed", rest),
    ),
    Match.exhaustive,
  )

const parseAlt = (alt: Chars): Result.Result<ConfigSelector, ParseError> =>
  Option.match(prefixOf(alt), {
    onNone: () => parsePath(alt),
    onSome: ([prefix, rest]) => parsePrefixed(prefix, rest),
  })

const unionOf = (selectors: ReadonlyArray<ConfigSelector>): ConfigSelector => {
  const [only] = selectors
  return only !== undefined && selectors.length === 1 ? only : { _tag: "Any", selectors }
}

/** Errors in this order: `Empty`, `UnbalancedBraces`, then the first failing alternative. */
export const parse = (input: string): Result.Result<ConfigSelector, ParseError> =>
  Result.gen(function* () {
    const chars = Array.from(input)
    if (chars.length === 0) return yield* Result.fail<ParseError>({ _tag: "Empty" })
    const alternatives = yield* expand(chars)
    const selectors = yield* Result.all(alternatives.map(parseAlt))
    return unionOf(selectors)
  })

const renderToken = (token: SegmentToken): string =>
  Match.valueTags(token, { Literal: ({ char }) => char, One: () => "?", Star: () => "*" })

const renderPathToken = (token: PathToken): string =>
  Match.valueTags(token, {
    Segment: ({ tokens }) => tokens.map(renderToken).join(""),
    Globstar: () => "**",
  })

/** `./` keeps a glob from reading as a prefixed form, and keeps its own leading `./`. */
const guardDot = (body: string): string => {
  const chars = Array.from(body)
  return Option.isNone(prefixOf(chars)) && dropLeadingDotSlash(chars).length === chars.length ? body : `./${body}`
}

const printBase = (selector: Selector): Option.Option<string> =>
  Match.valueTags(selector, {
    Glob: ({ tokens }) => Option.some(guardDot(tokens.map(renderPathToken).join("/"))),
    Package: ({ name }) => Option.some(`npm:${name ?? "*"}`),
    Builtin: ({ runtime, name }) => Option.some(`${runtime}:${name ?? "*"}`),
    Unresolved: () => Option.some("unresolved:*"),
    Computed: () => Option.some("computed:*"),
    Any: () => Option.none(),
    All: () => Option.none(),
    Not: () => Option.none(),
  })

const printOne = (selector: ConfigSelector): Option.Option<string> =>
  Match.valueTags(selector, {
    Base: ({ selector: inner }) => printBase(inner),
    Layer: ({ name }) => Option.some(`layer:${name}`),
    Any: () => Option.none(),
    All: () => Option.none(),
    Not: () => Option.none(),
  })

/** `none` for selectors that `parse` never produces. A glob without wildcard tokens is not checked. */
export const print = (selector: ConfigSelector): Option.Option<string> =>
  Match.value(selector).pipe(
    Match.tag("Any", ({ selectors }) =>
      selectors.length < 2
        ? Option.none()
        : Option.map(Option.all(selectors.map(printOne)), (texts) => `{${texts.join(",")}}`),
    ),
    Match.orElse(printOne),
  )

const explain = (error: ParseError): string =>
  Match.valueTags(error, {
    Empty: () => "Empty: the selector is an empty string",
    InvalidName: ({ kind, name }) => `InvalidName: "${name}" is not a valid name after "${kind}:"`,
    InvalidSegment: ({ text: segment }) =>
      `InvalidSegment: "${segment}" is not a path segment (segments are not empty, "." or "..")`,
    Unsupported: ({ char }) => `Unsupported: "${char}" is not allowed (use "/" and no character classes)`,
    UnbalancedBraces: () => "UnbalancedBraces: a brace or a comma has no partner",
  })

/** Selector text and its selector: decoding parses, encoding prints. */
export const SelectorText: Schema.Codec<ConfigSelector, string> = Schema.String.pipe(
  Schema.decodeTo(
    ConfigSelector,
    SchemaTransformation.transformEffect({
      decode: (input, options) =>
        Effect.fromResult(
          Result.mapError(
            parse(input),
            (error) => new SchemaIssue.InvalidValue({ message: explain(error) }, input, options),
          ),
        ),
      encode: (selector, options) =>
        Effect.fromOption(
          print(selector),
          () =>
            new SchemaIssue.InvalidValue(
              { message: "this selector has no text form; only the selectors that parse produces can be printed" },
              selector,
              options,
            ),
        ),
    }),
  ),
)
