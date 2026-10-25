import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { Workspace } from "../../src/analyzer/Analyzer.ts"
import { compareCodeUnits, isDeclarationFileName, splitPath } from "../../src/analyzer/paths.ts"
import { countLines } from "../../src/analyzer/syntax.ts"
import {
  builtinTarget,
  fileCandidates,
  installedPackage,
  packageTarget,
  specifierPackage,
} from "../../src/analyzer/targets.ts"

describe("builtinTarget", () => {
  it("accepts node: and bare built-in names", () => {
    expect(builtinTarget("node:fs")).toEqual({ _tag: "Builtin", runtime: "node", name: "fs" })
    expect(builtinTarget("fs")).toEqual({ _tag: "Builtin", runtime: "node", name: "fs" })
    expect(builtinTarget("fs/promises")).toEqual({ _tag: "Builtin", runtime: "node", name: "fs/promises" })
    expect(builtinTarget("node:test/reporters")).toEqual({ _tag: "Builtin", runtime: "node", name: "test/reporters" })
  })

  it("requires the prefix for modules that Node only knows with it", () => {
    expect(builtinTarget("test")).toBeUndefined()
    expect(builtinTarget("sqlite")).toBeUndefined()
    expect(builtinTarget("node:sqlite")).toEqual({ _tag: "Builtin", runtime: "node", name: "sqlite" })
  })

  it("treats bun: as the bun runtime", () => {
    expect(builtinTarget("bun:test")).toEqual({ _tag: "Builtin", runtime: "bun", name: "test" })
    expect(builtinTarget("bun")).toBeUndefined()
  })

  it("rejects a prefix with no name and other schemes", () => {
    expect(builtinTarget("node:")).toBeUndefined()
    expect(builtinTarget("bun:")).toBeUndefined()
    expect(builtinTarget("https://example.com/x.js")).toBeUndefined()
    expect(builtinTarget("effect")).toBeUndefined()
  })
})

describe("package names", () => {
  it("splits a specifier into a scope-aware name and a subpath", () => {
    expect(specifierPackage("react")).toEqual({ name: "react", subpath: [] })
    expect(specifierPackage("react/jsx-runtime")).toEqual({ name: "react", subpath: ["jsx-runtime"] })
    expect(specifierPackage("@effect/platform-node")).toEqual({ name: "@effect/platform-node", subpath: [] })
    expect(specifierPackage("@scope/pkg/a/b")).toEqual({ name: "@scope/pkg", subpath: ["a", "b"] })
  })

  it("leaves paths, # imports, and schemes alone", () => {
    for (const specifier of ["./a", "../a", "/a", "#internal", "~icons/x", "virtual:module", "C:\\a", "@", "@scope", ""]) {
      expect(specifierPackage(specifier), specifier).toBeUndefined()
    }
  })

  it("reads the package from the last node_modules segment", () => {
    expect(installedPackage(["repo", "node_modules", "react", "index.js"])).toEqual({ name: "react", subpath: ["index.js"] })
    expect(installedPackage(["repo", "node_modules", "@types", "react", "index.d.ts"])).toEqual({
      name: "@types/react",
      subpath: ["index.d.ts"],
    })
    expect(installedPackage(["r", "node_modules", ".pnpm", "a@1", "node_modules", "a", "lib", "x.js"])).toEqual({
      name: "a",
      subpath: ["lib", "x.js"],
    })
    expect(installedPackage(["repo", "src", "a.ts"])).toBeUndefined()
  })

  it("keeps the written name when the file belongs to the package or its @types", () => {
    const types = installedPackage(["node_modules", "@types", "picomatch", "index.d.ts"])
    expect(packageTarget("picomatch", types)).toEqual({ _tag: "Package", name: "picomatch", subpath: [] })
    expect(packageTarget("picomatch/lib/x", types)).toEqual({ _tag: "Package", name: "picomatch", subpath: ["lib", "x"] })
    const scoped = installedPackage(["node_modules", "@types", "babel__core", "index.d.ts"])
    expect(packageTarget("@babel/core", scoped)).toEqual({ _tag: "Package", name: "@babel/core", subpath: [] })
  })

  it("takes the name from the file when the specifier is not that package", () => {
    const installed = installedPackage(["node_modules", "real", "src", "index.d.ts"])
    expect(packageTarget("@alias/real", installed)).toEqual({ _tag: "Package", name: "real", subpath: ["src", "index.d.ts"] })
    expect(packageTarget("#dep", installed)).toEqual({ _tag: "Package", name: "real", subpath: ["src", "index.d.ts"] })
  })
})

describe("fileCandidates", () => {
  it("tries the path, its TypeScript twin, extensions, and index files in order", () => {
    expect(fileCandidates("/r/a.js").slice(0, 4)).toEqual(["/r/a.js", "/r/a.ts", "/r/a.tsx", "/r/a.js.ts"])
    expect(fileCandidates("/r/a.cjs")[1]).toBe("/r/a.cts")
    expect(fileCandidates("/r/dir")).toContain("/r/dir/index.ts")
  })
})

describe("paths", () => {
  it("compares strings by UTF-16 code unit", () => {
    expect(["\u{FF5E}", "\u{1F600}", "z", "B"].toSorted(compareCodeUnits)).toEqual(["B", "z", "\u{1F600}", "\u{FF5E}"])
    expect(compareCodeUnits("a", "a")).toBe(0)
  })

  it("splits either separator and drops empty segments", () => {
    expect(splitPath("/a//b\\c/")).toEqual(["a", "b", "c"])
  })

  it("recognizes declaration files", () => {
    for (const name of ["a.d.ts", "a.d.mts", "a.d.cts", "a.d.css.ts", "/x/y.d.ts"]) {
      expect(isDeclarationFileName(name), name).toBe(true)
    }
    for (const name of ["a.ts", "a.tsx", "d.ts", "a.mts", "a.d.tsx", "a.json"]) {
      expect(isDeclarationFileName(name), name).toBe(false)
    }
  })
})

describe("countLines", () => {
  it("counts newline-separated lines and ignores a final newline", () => {
    expect(
      ["", "a", "a\n", "a\nb", "a\nb\n", "\n", "\n\n", "a\r\nb\r\n"].map(countLines),
    ).toEqual([0, 1, 1, 2, 2, 1, 2, 2])
  })
})

describe("Workspace", () => {
  const decode = Schema.decodeUnknownResult(Workspace)

  it("accepts an absolute root and relative tsconfig paths", () => {
    expect(decode({ root: "/repo", projects: ["tsconfig.json", "packages/a/tsconfig.json"] })._tag).toBe("Success")
  })

  it("rejects a relative root, no projects, and an absolute project", () => {
    expect(decode({ root: "repo", projects: ["tsconfig.json"] })._tag).toBe("Failure")
    expect(decode({ root: "/repo", projects: [] })._tag).toBe("Failure")
    expect(decode({ root: "/repo", projects: ["/repo/tsconfig.json"] })._tag).toBe("Failure")
    expect(decode({ root: "/repo", projects: [""] })._tag).toBe("Failure")
  })
})
