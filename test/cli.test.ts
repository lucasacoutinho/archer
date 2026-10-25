import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"

const main = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url))
const fixture = fileURLToPath(new URL("fixtures/project", import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), "archer-cli-"))

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const config = (file: string, text: string) => {
  const path = join(scratch, file)
  writeFileSync(path, text)
  return path
}

const index = fileURLToPath(new URL("../src/index.ts", import.meta.url))

const failing = config(
  "failing.config.ts",
  `import { defineConfig } from ${JSON.stringify(index)}
export default defineConfig({
  root: ${JSON.stringify(fixture)},
  layers: { application: "src/application", domain: "src/domain", infrastructure: "src/infrastructure" },
  stack: ["application", "domain"],
  baseline: false,
})
`,
)

const passing = config(
  "passing.config.ts",
  `import { defineConfig, r } from ${JSON.stringify(index)}
export default defineConfig({ root: ${JSON.stringify(fixture)}, rules: [r.maxLines("short", "src", 1000)], baseline: false })
`,
)

const archer = (...args: ReadonlyArray<string>) => {
  const result = spawnSync(process.execPath, [main, ...args], { cwd: scratch, encoding: "utf8" })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe("archer CLI", () => {
  it("exits 1 on a failing report and 0 on a passing one", () => {
    const failed = archer("check", "-c", failing, "-r", "agent")
    expect(failed.status).toBe(1)
    expect(failed.stdout).toContain('rule="layer/application"')
    expect(archer("check", "-c", passing).status).toBe(0)
  }, 60_000)

  it("checks a saved graph with the same verdict", () => {
    const saved = join(scratch, "graph.json")
    expect(archer("graph", "-c", failing, "-o", saved).status).toBe(0)
    expect(JSON.parse(readFileSync(saved, "utf8"))).toMatchObject({ format: "archer-graph", version: 1 })
    const replayed = archer("check", "-c", failing, "--graph", saved, "-r", "agent")
    expect([replayed.status, replayed.stdout]).toEqual([1, archer("check", "-c", failing, "-r", "agent").stdout])
  }, 60_000)

  it("writes every reporter's output", () => {
    for (const reporter of ["pretty", "agent", "json", "sarif", "github", "dot"]) {
      const output = join(scratch, `report.${reporter}`)
      archer("check", "-c", failing, "-r", reporter, "-o", output)
      expect(readFileSync(output, "utf8").length).toBeGreaterThan(0)
    }
  }, 120_000)

  it("exits 2 with a readable message when it cannot check", () => {
    const invalid = config("invalid.config.ts", `export default { layers: { a: "src//x" }, stack: ["ghost"] }\n`)
    const result = archer("check", "-c", invalid)
    expect([result.status, result.stderr.trim()]).toEqual([
      2,
      "Invalid configuration:\n  - layers.a: 'src//x' is not a selector (InvalidSegment)",
    ])
    expect(archer("check", "-c", join(scratch, "absent.config.ts")).status).toBe(2)
  }, 60_000)

  it("reports baselined violations with --ignore-baseline", () => {
    const baselined = config(
      "baselined.config.ts",
      readFileSync(failing, "utf8").replace("baseline: false", `baseline: ${JSON.stringify(join(scratch, "accepted"))}`),
    )
    expect(archer("baseline", "-c", baselined, "record").status).toBe(0)
    expect(archer("check", "-c", baselined).status).toBe(0)
    expect(archer("check", "-c", baselined, "--ignore-baseline").status).toBe(1)
  }, 60_000)

  it("exits 2 on a usage error and prints the version from package.json", () => {
    expect(archer("check", "-r", "xml").status).toBe(2)
    expect(archer("--version").stdout).toContain(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version)
  })

  it("creates a starter configuration once", () => {
    const directory = mkdtempSync(join(scratch, "init-"))
    const first = spawnSync(process.execPath, [main, "init"], { cwd: directory, encoding: "utf8" })
    const second = spawnSync(process.execPath, [main, "init"], { cwd: directory, encoding: "utf8" })
    expect(first.status).toBe(0)
    expect(readFileSync(join(directory, "archer.config.ts"), "utf8")).toContain("defineConfig")
    expect([second.status, second.stderr]).toEqual([1, expect.stringContaining("already exists")])
  }, 60_000)
})

describe("archer check --watch", () => {
  it("re-checks after a change, reloading modules the configuration imports", async () => {
    const project = mkdtempSync(join(scratch, "watch-"))
    writeFileSync(join(project, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "nodenext" }, include: ["src"] }))
    rmSync(join(project, "src"), { recursive: true, force: true })
    spawnSync("mkdir", ["-p", join(project, "src")])
    writeFileSync(join(project, "src", "a.ts"), "export const a = 1\nexport const b = 2\nexport const c = 3\n")
    writeFileSync(join(project, "limits.ts"), "export const limit = 100\n")
    writeFileSync(
      join(project, "archer.config.ts"),
      `import { defineConfig, r } from ${JSON.stringify(index)}
import { limit } from "./limits.ts"
export default defineConfig({ rules: [r.maxLines("size", "src", limit)], baseline: false })
`,
    )
    const child = spawn(process.execPath, [main, "check", "-w", "-r", "agent"], { cwd: project })
    let output = ""
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()))
    const waitFor = async (text: string, count: number): Promise<void> => {
      const deadline = Date.now() + 30_000
      while (output.split(text).length - 1 < count) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${count}× ${text}; output:\n${output}`)
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    try {
      await waitFor("verdict=pass", 1)
      writeFileSync(join(project, "limits.ts"), "export const limit = 2\n")
      await waitFor("verdict=fail", 1)
      writeFileSync(join(project, "src", "a.ts"), "export const a = 1\n")
      await waitFor("verdict=pass", 2)
      const runs = output.split("summary").length
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      expect(output.split("summary").length).toBe(runs)
    } finally {
      child.kill()
    }
  }, 90_000)

  it("does not re-check because of its own report file", async () => {
    const project = mkdtempSync(join(scratch, "watch-output-"))
    spawnSync("mkdir", ["-p", join(project, "src")])
    writeFileSync(join(project, "tsconfig.json"), JSON.stringify({ include: ["src"] }))
    writeFileSync(join(project, "src", "a.ts"), "export const a = 1\n")
    writeFileSync(
      join(project, "archer.config.ts"),
      `import { defineConfig, r } from ${JSON.stringify(index)}
export default defineConfig({ rules: [r.maxLines("size", "src", 100)], baseline: false })
`,
    )
    const report = join(project, "report.txt")
    const child = spawn(process.execPath, [main, "check", "-w", "-r", "agent", "-o", report], { cwd: project })
    try {
      const deadline = Date.now() + 30_000
      while (!existsSync(report)) {
        if (Date.now() > deadline) throw new Error("the watcher never wrote its report")
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      const first = statSync(report).mtimeMs
      writeFileSync(join(project, "src", "a.ts"), "export const a = 2\n")
      while (statSync(report).mtimeMs === first) {
        if (Date.now() > deadline) throw new Error("the watcher never re-checked after a change")
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      const written = statSync(report).mtimeMs
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      expect(statSync(report).mtimeMs).toBe(written)
    } finally {
      child.kill()
    }
  }, 60_000)
})
