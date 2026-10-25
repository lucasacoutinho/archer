import { createHook } from "node:async_hooks"

const creation = new WeakMap<object, string>()
Error.stackTraceLimit = 60
createHook({
  init(_id, type, _trigger, resource) {
    if (type === "PROMISE") creation.set(resource as object, new Error("created at").stack ?? "")
  },
}).enable()
process.on("unhandledRejection", (_reason, promise) => {
  console.log(`DEBUG-UNHANDLED creation stack:\n${creation.get(promise) ?? "unknown"}`)
})

import { NodeServices } from "@effect/platform-node"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import { execFileSync } from "node:child_process"
import { Analyzer } from "../../src/analyzer/Analyzer.ts"
import type { Graph, SourceFile, Target } from "../../src/core/model.ts"

const live = Analyzer.typescript.pipe(Layer.provideMerge(NodeServices.layer))

const tsconfig = (include: ReadonlyArray<string>, options: Record<string, unknown> = {}): string =>
  JSON.stringify({
    compilerOptions: { module: "nodenext", moduleResolution: "nodenext", skipLibCheck: true, ...options },
    include,
  })

interface Layout {
  readonly files: Readonly<Record<string, string>>
  /** Link path to link target, both relative to the root unless the target is absolute. */
  readonly links?: Readonly<Record<string, string>>
}

const makeRoot = (layout: Layout) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "archer-analyzer-" })
    const parentOf = (name: string) => fs.makeDirectory(path.dirname(path.join(root, name)), { recursive: true })
    for (const [name, content] of Object.entries(layout.files)) {
      yield* parentOf(name)
      yield* fs.writeFileString(path.join(root, name), content)
    }
    for (const [name, target] of Object.entries(layout.links ?? {})) {
      yield* parentOf(name)
      yield* fs.symlink(path.isAbsolute(target) ? target : path.resolve(path.dirname(path.join(root, name)), target), path.join(root, name))
    }
    return yield* fs.realPath(root)
  })

const paths = (graph: Graph): ReadonlyArray<string> => graph.files.map((file) => file.path.join("/"))

const targetsOf = (file: SourceFile | undefined): ReadonlyArray<Target> => (file?.dependencies ?? []).map((dependency) => dependency.target)

const fileOf = (graph: Graph, path: string): SourceFile | undefined => graph.files.find((file) => file.path.join("/") === path)

const liveChildren = (): ReadonlyArray<number> =>
  execFileSync("ps", ["-o", "pid=,stat=,comm=", "--ppid", String(process.pid)], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .filter(([, stat, comm]) => stat !== undefined && !stat.startsWith("Z") && comm !== "ps")
    .map(([pid]) => Number(pid))

const childrenAfterExit = (expected: ReadonlyArray<number>): Effect.Effect<ReadonlyArray<number>> =>
  Effect.promise(async () => {
    for (let attempt = 0; attempt < 100 && liveChildren().length > expected.length; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    return liveChildren()
  })

const simple = (files: Record<string, string>): Layout => ({
  files: { "tsconfig.json": tsconfig(["src"]), ...files },
})

layer(live)("typescript analyzer", (it) => {
  it.effect("fails with ProjectNotFound for a missing tsconfig", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot(simple({ "src/a.ts": "export {}\n" }))
      const error = yield* Analyzer.use((analyzer) => analyzer.analyze({ root, projects: ["tsconfig.json", "missing/tsconfig.json"] })).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "ProjectNotFound", tsconfig: "missing/tsconfig.json" })
    }),
  )

  it.effect("fails with ProjectParseFailed and the diagnostics for a broken tsconfig", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot({ files: { "tsconfig.json": '{ "compilerOptions": ', "src/a.ts": "export {}\n" } })
      const error = yield* Analyzer.use((analyzer) => analyzer.analyze({ root, projects: ["tsconfig.json"] })).pipe(Effect.flip)
      expect(error._tag).toBe("ProjectParseFailed")
      expect(error).toMatchObject({ tsconfig: "tsconfig.json" })
      expect(error._tag === "ProjectParseFailed" && error.diagnostics[0]?.startsWith("tsconfig.json: TS")).toBe(true)
    }),
  )

  it.effect("fails with ProjectParseFailed for an invalid compiler option", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot({ files: { "tsconfig.json": tsconfig(["src"], { module: "bogus" }), "src/a.ts": "export {}\n" } })
      const error = yield* Analyzer.use((analyzer) => analyzer.analyze({ root, projects: ["tsconfig.json"] })).pipe(Effect.flip)
      expect(error._tag === "ProjectParseFailed" && error.diagnostics.some((line) => line.includes("TS6046"))).toBe(true)
    }),
  )

  it.effect("reads the files again on every call", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const analyzer = yield* Analyzer
      const root = yield* makeRoot(simple({ "src/a.ts": "export const a = 1\n", "src/b.ts": "export const b = 1\n", "src/gone.ts": "export {}\n" }))
      const workspace = { root, projects: ["tsconfig.json"] as [string] }
      const before = yield* analyzer.analyze(workspace)
      expect(paths(before)).toEqual(["src/a.ts", "src/b.ts", "src/gone.ts"])

      yield* fs.writeFileString(`${root}/src/a.ts`, 'import { b } from "./b.js"\nexport const a = b\n')
      yield* fs.writeFileString(`${root}/src/c.ts`, "export const c = 1\n")
      yield* fs.remove(`${root}/src/gone.ts`)
      const after = yield* analyzer.analyze(workspace)

      expect(paths(after)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"])
      expect(targetsOf(fileOf(after, "src/a.ts"))).toEqual([{ _tag: "File", path: ["src", "b.ts"] }])
      expect(fileOf(after, "src/a.ts")?.lines).toBe(2)
    }),
  )

  it.effect("sees a changed tsconfig on the next call", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const analyzer = yield* Analyzer
      const root = yield* makeRoot({ files: { "tsconfig.json": tsconfig(["src/a.ts"]), "src/a.ts": "export {}\n", "src/b.ts": "export {}\n" } })
      const workspace = { root, projects: ["tsconfig.json"] as [string] }
      expect(paths(yield* analyzer.analyze(workspace))).toEqual(["src/a.ts"])
      yield* fs.writeFileString(`${root}/tsconfig.json`, tsconfig(["src"]))
      expect(paths(yield* analyzer.analyze(workspace))).toEqual(["src/a.ts", "src/b.ts"])
    }),
  )

  it.effect("sees a changed extended config and a package installed after the first call", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const analyzer = yield* Analyzer
      const root = yield* makeRoot({
        files: {
          "base.json": JSON.stringify({ include: ["src"] }),
          "tsconfig.json": JSON.stringify({ extends: "./base.json", compilerOptions: { module: "nodenext", moduleResolution: "nodenext" } }),
          "src/a.ts": 'import "later-pkg"\n',
        },
      })
      const workspace = { root, projects: ["tsconfig.json"] as [string] }
      const before = yield* analyzer.analyze(workspace)
      expect(paths(before)).toEqual(["src/a.ts"])
      expect(targetsOf(fileOf(before, "src/a.ts"))).toEqual([{ _tag: "Unresolved", specifier: "later-pkg" }])

      yield* fs.makeDirectory(`${root}/node_modules/later-pkg`, { recursive: true })
      yield* fs.writeFileString(`${root}/node_modules/later-pkg/package.json`, JSON.stringify({ name: "later-pkg", types: "index.d.ts" }))
      yield* fs.writeFileString(`${root}/node_modules/later-pkg/index.d.ts`, "export declare const x: number\n")
      yield* fs.writeFileString(`${root}/base.json`, JSON.stringify({ include: ["src", "extra"] }))
      yield* fs.makeDirectory(`${root}/extra`)
      yield* fs.writeFileString(`${root}/extra/b.ts`, "export {}\n")

      const after = yield* analyzer.analyze(workspace)
      expect(paths(after)).toEqual(["extra/b.ts", "src/a.ts"])
      expect(targetsOf(fileOf(after, "src/a.ts"))).toEqual([{ _tag: "Package", name: "later-pkg", subpath: [] }])
    }),
  )

  it.effect("returns identical graphs for concurrent calls", () =>
    Effect.gen(function* () {
      const analyzer = yield* Analyzer
      const root = yield* makeRoot(simple({ "src/a.ts": 'import "./b.js"\n', "src/b.ts": "export {}\n" }))
      const workspace = { root, projects: ["tsconfig.json"] as [string] }
      const graphs = yield* Effect.all([analyzer.analyze(workspace), analyzer.analyze(workspace), analyzer.analyze(workspace)], { concurrency: 3 })
      expect(graphs[1]).toEqual(graphs[0])
      expect(graphs[2]).toEqual(graphs[0])
    }),
  )

  it.effect("compares paths by UTF-16 code unit, not by code point or locale", () =>
    Effect.gen(function* () {
      const analyzer = yield* Analyzer
      const names = ["z", "\u{FF5E}", "\u{1F600}", "B", "a", "\u{E9}"]
      const root = yield* makeRoot(simple(Object.fromEntries(names.map((name) => [`src/${name}.ts`, "export {}\n"]))))
      const graph = yield* analyzer.analyze({ root, projects: ["tsconfig.json"] })
      expect(paths(graph)).toEqual(["B", "a", "z", "\u{E9}", "\u{1F600}", "\u{FF5E}"].map((name) => `src/${name}.ts`))
    }),
  )

  it.effect("analyzes a file listed by several projects through the first project that lists it", () =>
    Effect.gen(function* () {
      const analyzer = yield* Analyzer
      const root = yield* makeRoot({
        files: {
          "one/tsconfig.json": tsconfig(["../shared", "x.ts"], { paths: { "@x": ["./x.ts"] } }),
          "one/x.ts": "export {}\n",
          "two/tsconfig.json": tsconfig(["../shared", "x.ts"], { paths: { "@x": ["./x.ts"] } }),
          "two/x.ts": "export {}\n",
          "shared/main.ts": 'import "@x"\n',
        },
      })
      const analyze = (projects: [string, string]) => analyzer.analyze({ root, projects })
      const oneFirst = yield* analyze(["one/tsconfig.json", "two/tsconfig.json"])
      const twoFirst = yield* analyze(["two/tsconfig.json", "one/tsconfig.json"])
      expect(paths(oneFirst)).toEqual(["one/x.ts", "shared/main.ts", "two/x.ts"])
      expect(paths(twoFirst)).toEqual(paths(oneFirst))
      expect(targetsOf(fileOf(oneFirst, "shared/main.ts"))).toEqual([{ _tag: "File", path: ["one", "x.ts"] }])
      expect(targetsOf(fileOf(twoFirst, "shared/main.ts"))).toEqual([{ _tag: "File", path: ["two", "x.ts"] }])
    }),
  )

  it.effect("lists the union of several projects and a file once", () =>
    Effect.gen(function* () {
      const analyzer = yield* Analyzer
      const root = yield* makeRoot({
        files: {
          "a/tsconfig.json": tsconfig(["src", "../common"]),
          "a/src/a.ts": 'import "../../common/c.js"\n',
          "b/tsconfig.json": tsconfig(["src", "../common"]),
          "b/src/b.ts": "export {}\n",
          "common/c.ts": "export {}\n",
        },
      })
      const graph = yield* analyzer.analyze({ root, projects: ["a/tsconfig.json", "b/tsconfig.json", "a/tsconfig.json"] })
      expect(paths(graph)).toEqual(["a/src/a.ts", "b/src/b.ts", "common/c.ts"])
      expect(targetsOf(fileOf(graph, "a/src/a.ts"))).toEqual([{ _tag: "File", path: ["common", "c.ts"] }])
    }),
  )

  it.effect("normalizes symlinks, names packages, and finds packages without types", () =>
    Effect.gen(function* () {
      const analyzer = yield* Analyzer
      const outside = yield* makeRoot({ files: { "thing.ts": "export {}\n" } })
      const packageJson = (name: string, extra: Record<string, unknown> = {}) => JSON.stringify({ name, version: "1.0.0", ...extra })
      const typedExports = (types: string) => ({ exports: { ".": { types: `./${types}.d.ts`, default: `./${types}.js` } } })
      const root = yield* makeRoot({
        files: {
          "tsconfig.json": tsconfig(["src", "lib", "packages/*/src"]),
          "src/main.ts": [
            'import { a } from "typed-pkg"',
            'import { b } from "typed-pkg/sub"',
            'import { c } from "@scope/scoped"',
            'import { d } from "@scope/scoped/feature"',
            'import legacy from "untyped-pkg"',
            'import { e } from "dual-types"',
            'import { f } from "pnpm-pkg"',
            'import { g } from "linked"',
            'import "./alias.js"',
            'import "./outside.js"',
            "",
          ].join("\n"),
          "lib/real.ts": "export const real = 1\n",
          "packages/linked/package.json": packageJson("linked", { types: "./src/index.ts", main: "./src/index.ts" }),
          "packages/linked/src/index.ts": "export const g = 1\n",
          "node_modules/typed-pkg/package.json": packageJson("typed-pkg", {
            exports: {
              ".": { types: "./index.d.ts", default: "./index.js" },
              "./sub": { types: "./sub.d.ts", default: "./sub.js" },
            },
          }),
          "node_modules/typed-pkg/index.d.ts": "export declare const a: number\n",
          "node_modules/typed-pkg/index.js": "exports.a = 1\n",
          "node_modules/typed-pkg/sub.d.ts": "export declare const b: number\n",
          "node_modules/typed-pkg/sub.js": "exports.b = 1\n",
          "node_modules/@scope/scoped/package.json": packageJson("@scope/scoped", {
            exports: {
              ".": { types: "./index.d.ts", default: "./index.js" },
              "./feature": { types: "./feature.d.ts", default: "./feature.js" },
            },
          }),
          "node_modules/@scope/scoped/index.d.ts": "export declare const c: number\n",
          "node_modules/@scope/scoped/index.js": "exports.c = 1\n",
          "node_modules/@scope/scoped/feature.d.ts": "export declare const d: number\n",
          "node_modules/@scope/scoped/feature.js": "exports.d = 1\n",
          "node_modules/untyped-pkg/package.json": packageJson("untyped-pkg", { main: "index.js" }),
          "node_modules/untyped-pkg/index.js": "module.exports = {}\n",
          "node_modules/dual-types/package.json": packageJson("dual-types", { main: "index.js" }),
          "node_modules/dual-types/index.js": "exports.e = 1\n",
          "node_modules/@types/dual-types/package.json": packageJson("@types/dual-types", { types: "index.d.ts" }),
          "node_modules/@types/dual-types/index.d.ts": "export declare const e: number\n",
          "node_modules/.pnpm/pnpm-pkg@1.0.0/node_modules/pnpm-pkg/package.json": packageJson("pnpm-pkg", typedExports("index")),
          "node_modules/.pnpm/pnpm-pkg@1.0.0/node_modules/pnpm-pkg/index.d.ts": "export declare const f: number\n",
          "node_modules/.pnpm/pnpm-pkg@1.0.0/node_modules/pnpm-pkg/index.js": "exports.f = 1\n",
        },
        links: {
          "src/alias.ts": "../lib/real.ts",
          "src/outside.ts": `${outside}/thing.ts`,
          "node_modules/linked": "../packages/linked",
          "node_modules/pnpm-pkg": ".pnpm/pnpm-pkg@1.0.0/node_modules/pnpm-pkg",
        },
      })
      const graph = yield* analyzer.analyze({ root, projects: ["tsconfig.json"] })
      expect(paths(graph)).toEqual(["lib/real.ts", "packages/linked/src/index.ts", "src/main.ts"])
      expect(targetsOf(fileOf(graph, "src/main.ts"))).toEqual([
        { _tag: "Package", name: "typed-pkg", subpath: [] },
        { _tag: "Package", name: "typed-pkg", subpath: ["sub"] },
        { _tag: "Package", name: "@scope/scoped", subpath: [] },
        { _tag: "Package", name: "@scope/scoped", subpath: ["feature"] },
        { _tag: "Package", name: "untyped-pkg", subpath: [] },
        { _tag: "Package", name: "dual-types", subpath: [] },
        { _tag: "Package", name: "pnpm-pkg", subpath: [] },
        { _tag: "File", path: ["packages", "linked", "src", "index.ts"] },
        { _tag: "File", path: ["lib", "real.ts"] },
        { _tag: "Unresolved", specifier: "./outside.js" },
      ])
    }),
  )

  it.effect("gives a root reached through a symlink the same graph as the real root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const analyzer = yield* Analyzer
      const root = yield* makeRoot(simple({ "src/a.ts": 'import "./b.js"\n', "src/b.ts": "export {}\n" }))
      const link = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "archer-link-" }), "root")
      yield* fs.symlink(root, link)
      const direct = yield* analyzer.analyze({ root, projects: ["tsconfig.json"] })
      const linked = yield* analyzer.analyze({ root: link, projects: ["tsconfig.json"] })
      expect(linked).toEqual(direct)
      expect(paths(linked)).toEqual(["src/a.ts", "src/b.ts"])
    }),
  )

  it.effect("keeps declaration files, JSON, and listed files under node_modules out of the source set", () =>
    Effect.gen(function* () {
      const analyzer = yield* Analyzer
      const root = yield* makeRoot({
        files: {
          "tsconfig.json": JSON.stringify({
            compilerOptions: { module: "nodenext", moduleResolution: "nodenext", resolveJsonModule: true },
            files: ["src/a.ts", "src/types.d.ts", "src/data.json", "node_modules/pkg/index.ts"],
          }),
          "src/a.ts": "export {}\n",
          "src/types.d.ts": "export {}\n",
          "src/data.json": "{}\n",
          "node_modules/pkg/index.ts": "export {}\n",
        },
      })
      expect(paths(yield* analyzer.analyze({ root, projects: ["tsconfig.json"] }))).toEqual(["src/a.ts"])
    }),
  )

  it.effect("resolves require() in JavaScript files through the checker, path aliases included", () =>
    Effect.gen(function* () {
      const analyzer = yield* Analyzer
      const root = yield* makeRoot({
        files: {
          "tsconfig.json": tsconfig(["src"], { allowJs: true, paths: { "@b": ["./src/b.js"] } }),
          "src/a.js": ["const b = require('@b')", "const { x: y } = require('./c')", "y()", "require(b)", ""].join("\n"),
          "src/b.js": "module.exports = {}\n",
          "src/c.js": "exports.x = () => 1\n",
        },
      })
      const graph = yield* analyzer.analyze({ root, projects: ["tsconfig.json"] })
      expect(fileOf(graph, "src/a.js")?.dependencies.map(({ kind, specifier, target }) => [kind, specifier, target._tag])).toEqual([
        ["require", "@b", "File"],
        ["require", "./c", "File"],
        ["require", "b", "Computed"],
      ])
      expect(targetsOf(fileOf(graph, "src/a.js")).slice(0, 2)).toEqual([
        { _tag: "File", path: ["src", "b.js"] },
        { _tag: "File", path: ["src", "c.js"] },
      ])
      expect(fileOf(graph, "src/a.js")?.uses.find(({ name }) => name === "y")?.binding).toEqual({
        _tag: "Imported",
        name: { source: "./c", name: "x" },
      })
    }),
  )

  it.effect("counts lines by newline, ignoring a final newline", () =>
    Effect.gen(function* () {
      const analyzer = yield* Analyzer
      const root = yield* makeRoot(
        simple({
          "src/empty.ts": "",
          "src/one.ts": "export {}",
          "src/one-newline.ts": "export {}\n",
          "src/blank.ts": "\n",
          "src/two.ts": "export {}\n\n",
          "src/crlf.ts": "export {}\r\nexport {}\r\n",
        }),
      )
      const graph = yield* analyzer.analyze({ root, projects: ["tsconfig.json"] })
      expect(graph.files.map((file) => [file.path.join("/"), file.lines])).toEqual([
        ["src/blank.ts", 1],
        ["src/crlf.ts", 2],
        ["src/empty.ts", 0],
        ["src/one-newline.ts", 1],
        ["src/one.ts", 1],
        ["src/two.ts", 2],
      ])
    }),
  )
})

layer(NodeServices.layer)("typescript analyzer process", (it) => {
  const analyzeOnce = (root: string) =>
    Analyzer.use((analyzer) => analyzer.analyze({ root, projects: ["tsconfig.json"] }))

  it.effect.skipIf(process.platform !== "linux")("starts the server on the first analyze, reuses it, and stops it with the layer scope", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot(simple({ "src/a.ts": "export {}\n" }))
      const before = liveChildren()
      const observed = yield* Effect.gen(function* () {
        const analyzer = yield* Analyzer
        const built = liveChildren()
        yield* analyzer.analyze({ root, projects: ["tsconfig.json"] })
        const first = liveChildren()
        yield* analyzer.analyze({ root, projects: ["tsconfig.json"] })
        return { built, first, second: liveChildren() }
      }).pipe(Effect.provide(Analyzer.typescript))

      expect(observed.built).toEqual(before)
      expect(observed.first).toHaveLength(before.length + 1)
      expect(observed.second).toEqual(observed.first)
      expect(yield* childrenAfterExit(before)).toEqual(before)
    }),
  )

  it.effect.skipIf(process.platform !== "linux")("keeps the server after a failed analysis", () =>
    Effect.gen(function* () {
      const broken = yield* makeRoot({ files: { "tsconfig.json": '{ "compilerOptions": ', "src/a.ts": "export {}\n" } })
      const fine = yield* makeRoot(simple({ "src/a.ts": "export {}\n" }))
      const before = liveChildren()
      const observed = yield* Effect.gen(function* () {
        const error = yield* analyzeOnce(broken).pipe(Effect.flip)
        const afterFailure = liveChildren()
        const graph = yield* analyzeOnce(fine)
        return { error, afterFailure, afterSuccess: liveChildren(), graph }
      }).pipe(Effect.provide(Analyzer.typescript))

      expect(observed.error._tag).toBe("ProjectParseFailed")
      expect(observed.afterFailure).toHaveLength(before.length + 1)
      expect(observed.afterSuccess).toEqual(observed.afterFailure)
      expect(paths(observed.graph)).toEqual(["src/a.ts"])
    }),
  )

  it.effect.skipIf(process.platform !== "linux")("reports a killed server as AnalyzerUnavailable and starts a new one on the next call", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot(simple({ "src/a.ts": "export {}\n" }))
      const before = liveChildren()
      const observed = yield* Effect.gen(function* () {
        yield* analyzeOnce(root)
        const server = liveChildren().filter((pid) => !before.includes(pid))
        server.forEach((pid) => process.kill(pid, "SIGKILL"))
        const error = yield* analyzeOnce(root).pipe(Effect.flip)
        const graph = yield* analyzeOnce(root)
        return { error, graph, replaced: liveChildren().filter((pid) => !before.includes(pid) && !server.includes(pid)) }
      }).pipe(Effect.provide(Analyzer.typescript))

      expect(observed.error._tag).toBe("AnalyzerUnavailable")
      expect(paths(observed.graph)).toEqual(["src/a.ts"])
      expect(observed.replaced).toHaveLength(1)
    }),
  )
})
