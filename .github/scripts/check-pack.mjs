// Verifies the tarball that `npm pack --dry-run --json` would produce.
//
//   npm pack --dry-run --json | node .github/scripts/check-pack.mjs
//
// Run it after `npm run build`: `dist/` is gitignored, so without a build the
// tarball would have no entry points.
import { readFileSync } from "node:fs"

const required = ["dist/index.js", "dist/index.d.ts", "dist/effect.js", "dist/effect.d.ts", "dist/cli/main.js"]
const forbidden = ["src/", "lean/", ".legacy/"]

const [pack] = JSON.parse(readFileSync(0, "utf8"))
const paths = pack.files.map((file) => file.path)

const problems = [
  ...required.filter((path) => !paths.includes(path)).map((path) => `missing ${path}`),
  ...paths.filter((path) => forbidden.some((prefix) => path.startsWith(prefix))).map((path) => `unexpected ${path}`),
]

if (problems.length > 0) {
  console.error(`${pack.name}@${pack.version}: tarball check failed`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log(`${pack.name}@${pack.version}: tarball ok (${paths.length} files, ${pack.size} bytes packed)`)
