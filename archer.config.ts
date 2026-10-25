import { defineConfig, r, use } from "./src/index.ts"

const configLoader = "src/shell/load-config.ts"

export default defineConfig({
  layers: {
    cli: "src/cli",
    entry: ["src/index.ts", "src/effect.ts"],
    run: "src/run.ts",
    config: "src/config",
    shell: "src/shell",
    report: "src/report",
    analyzer: "src/analyzer",
    core: "src/core",
  },
  stack: ["cli", "entry", "run", "config", "shell", "report", "analyzer", "core"],
  rules: [
    r.acyclic("archer/acyclic", "src"),
    r.resolvable("archer/resolvable", { all: ["src", { not: configLoader }] }),
    r.resolvable("archer/resolvable-loader", configLoader, {
      allowComputed: true,
      reason: "The configuration loader imports the user's archer.config.ts by path: the one computed import.",
    }),
    r.onlyDependOn("core/pure", "layer:core", ["layer:core", "npm:effect"], {
      reason: "The core is the port of the Lean model: no platform, no TypeScript, no I/O.",
    }),
    r.forbid("typescript/only-in-analyzer", { all: ["src", { not: ["layer:analyzer", configLoader] }] }, "npm:typescript", {
      reason: "The analyzer is the only module that talks to TypeScript.",
    }),
    r.forbid("platform/at-the-edges", { all: ["src", { not: ["layer:cli", "src/effect.ts", configLoader] }] }, "npm:@effect/platform-node", {
      reason: "Node services are provided by the composition roots: the CLI and ./effect.",
    }),
    r.exportsOnly(
      "api/root",
      "src/index.ts",
      [
        ...["ArchitectureError", "assertArchitecture", "check", "defineConfig", "dispose", "graphOf", "p", "presets", "r", "renderReport", "run", "use"],
        ...["ArcherConfig", "BaselineMode", "CustomCheck", "CustomContext", "Format", "Graph", "Report", "RuleSpec", "RunOptions", "RunResult", "SelectorInput"],
      ],
      { reason: "The root export is the public, Effect-free API. Growing it is a decision, made here." },
    ),
    r.forbid("api/root-wraps-effect", "src/index.ts", ["src/analyzer", "src/core/check.ts"], {
      reason: "The root export wraps ./effect and run; it does not reach into the analyzer or the core directly.",
    }),
    r.maxLines("size/files", "src", 450, { severity: "warning", reason: "A file this long is due for a split." }),
    r.forbidUse("no-loose-equality", "src", use.looseEquality),
  ],
})
