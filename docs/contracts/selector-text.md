# Contract: selector text

Lean: `lean/Archer/Text.lean` and `lean/Archer/Spec/Text.lean`
(`TextSpec parse print`, obligations S1–S6).

Callers write selectors as strings. Parsing turns a string into a
`ConfigSelector` in two steps: brace expansion, then classification of each
alternative.

## Grammar

1. **Braces.** `{a,b}` stands for the alternatives `a` and `b`, and braces
   may nest. Expansion happens on the whole string before anything else, so
   alternatives may span segments (`src/{a,b/c}/**`) and may mix forms
   (`{src/**,npm:react}`, `npm:{react,zod}`). Several alternatives give
   `any`. A `}` without its `{`, a `{` without its `}`, or a `,` outside
   braces is `unbalancedBraces`.
2. **Prefixed forms.** An alternative that starts with a prefix is not a
   path:

   | Text | Selector |
   | --- | --- |
   | `npm:*` | any package |
   | `npm:react`, `npm:@scope/name` | that package, with any subpath. Other names containing `/` are rejected |
   | `node:*`, `bun:*` | any built-in of that runtime |
   | `node:fs`, `node:fs/promises`, `bun:test` | that built-in |
   | `layer:app` | the layer named `app`, resolved during lowering |
   | `unresolved:*` | every unresolved import |
   | `computed:*` | every import without a static specifier |

   A prefixed form with a missing or forbidden name is `invalidName`. It is
   never read as a path.
3. **Path globs.** Every other alternative is a root-relative path glob:
   - A leading `./` is dropped. The rest splits on `/`.
   - A segment that is empty, `.`, or `..` is `invalidSegment`. This covers
     a leading or trailing `/` and `a//b`.
   - `\`, `[`, and `]` are `unsupported`. Paths use `/` on every platform,
     and character classes are not part of the syntax. The first design
     accepted classes through picomatch.
   - `**` as a whole segment matches any number of segments, including
     none. Elsewhere, `*` matches any run of characters within one segment
     and `?` matches exactly one character. Both match names that start with
     a dot.
   - **A plain path**, one without `*` or `?`, selects the file or directory
     it names and everything under it: `src/domain` means `src/domain/**`
     (S2). An alternative with a wildcard means exactly its tokens (S3).
4. **The empty string** is `empty`.

## Obligations

| ID | Obligation | Status |
| --- | --- | --- |
| S1 | Every parsed selector prints, and the printed text parses back to the same selector | proved |
| S2 | A plain path selects exactly the files at or under it | proved |
| S3 | A brace-free glob with a wildcard means its tokens, with no implicit `**` | proved |
| S4 | Braces denote the union of their alternatives | proved |
| S5 | The prefixed forms parse to their selectors | proved |
| S6 | Empty strings, unsupported characters, invalid segments, and invalid prefixed names are rejected with that reason | proved |

The clauses about one form apply to brace-free text, because brace
expansion runs first. For example, `npm:a,b` is `unbalancedBraces`, not
`invalidName`.

## Facts of the proved implementation

- **Expansion.** Nested braces flatten into one list of alternatives in
  left-major order, so `{a,b}{c,d}` gives `ac`, `ad`, `bc`, `bd`. The first
  failing alternative decides the error. Errors are checked in this order:
  `empty`, `unbalancedBraces`, then each alternative in turn.
- **Printing.** `print` writes globs with an explicit `**` (`src/domain`
  prints as `src/domain/**`) and `any` as `{a,b}`. It writes a leading `./`
  exactly when the glob text would otherwise start with a prefix or with
  `./`, so `./npm:x` prints as `./npm:x/**`. `print` returns nothing for
  selectors that `parse` never produces.
- **Package names.** `npm:@scope` is an unscoped package named `@scope`,
  because only names that contain `/` must have the `@scope/name` form.
  `layer:*` names a layer called `*`.

## Production correspondence

The TypeScript parser is a schema transformation from `String` to
`ConfigSelector`, ported from the Lean definition, with no regular
expressions. The `parse` and `print` oracle ops and random selector strings
in the differential tests are its T1 evidence.
