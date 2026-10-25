import { Match } from "effect"
import type { ConfigError } from "../core/config.ts"
import type { RunError } from "../run.ts"

const causeText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const rejection = (error: ConfigError): string =>
  Match.valueTags(error, {
    DuplicateLayer: ({ name }) => `layer '${name}' is defined twice`,
    UnknownLayer: ({ name }) => `layer '${name}' is used but not defined`,
    DuplicateRuleId: ({ id }) => `rule id '${id}' is used twice (layer rules are named layer/<name>, public APIs public-api/<name>)`,
    EmptyPolicy: () => "the configuration declares no rules",
  })

const list = (items: ReadonlyArray<string>): string => items.map((item) => `\n  - ${item}`).join("")

export const explain = (error: RunError): string =>
  Match.valueTags(error, {
    ConfigNotFound: ({ searched }) => `No configuration file. Looked for:${list(searched)}\nRun \`archer init\` to create one.`,
    ConfigLoadError: ({ path, cause }) => `Could not load ${path}: ${causeText(cause)}`,
    ConfigInvalid: ({ issues }) => `Invalid configuration:${list(issues)}`,
    ConfigRejected: ({ error: rejected }) => `Invalid configuration: ${rejection(rejected)}`,
    ProjectNotFound: ({ tsconfig }) => `No tsconfig at ${tsconfig}. Set \`root\` or \`projects\` in the configuration.`,
    ProjectParseFailed: ({ tsconfig, diagnostics }) => `Could not read ${tsconfig}:${list(diagnostics)}`,
    AnalyzerUnavailable: ({ cause }) => `The TypeScript analyzer stopped: ${causeText(cause)}`,
    GraphFileInvalid: ({ path, issue }) => `Not a graph saved by \`archer graph\`: ${path} (${issue})`,
    BaselineError: ({ path, reason, line }) =>
      `Baseline ${path}: ${reason}${line === undefined ? "" : ` at line ${line}`}. Record a new one with \`archer baseline record\`.`,
  })
