import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const cell = (value) => String(value).replaceAll("|", "\\|").replace(/\r?\n/g, "<br>")

export const renderTools = (tools) =>
  [
    "| MCP tool | Description | Required input | Optional input |",
    "| --- | --- | --- | --- |",
    ...tools.map((tool) => {
      const required = tool.input.required ?? []
      const optional = Object.keys(tool.input.properties ?? {}).filter((key) => !required.includes(key))
      const fields = (names) => (names.length === 0 ? "—" : names.map((name) => "`" + cell(name) + "`").join(", "))
      return `| \`${cell(tool.name)}\` | ${cell(tool.description)} | ${fields(required)} | ${fields(optional)} |`
    })
  ].join("\n")

export const replaceSection = (text, name, content) => {
  const start = `<!-- ${name}:start -->`
  const end = `<!-- ${name}:end -->`
  const first = text.indexOf(start)
  const last = text.indexOf(end)
  if (
    first === -1 ||
    last < first ||
    text.indexOf(start, first + start.length) !== -1 ||
    text.indexOf(end, last + end.length) !== -1
  )
    throw new Error(`README requires exactly one ordered ${name} marker pair`)
  return text.slice(0, first + start.length) + "\n\n" + content.trim() + "\n\n" + text.slice(last)
}

const main = async () => {
  const mode = process.argv[2]
  if (process.argv.length !== 3 || !["--update", "--check"].includes(mode))
    throw new Error("Usage: node scripts/generate-readme.mjs --update|--check")
  const root = resolve(import.meta.dirname, "..")
  const { catalog, jsonSchema } = await import("../dist/mcp/catalog.js")
  const help = execFileSync(process.execPath, [resolve(root, "dist/bin/slopmemr.mjs"), "--help"], {
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" }
  }).trim()
  const path = resolve(root, "README.md")
  const original = readFileSync(path, "utf8")
  const tools = catalog.map((tool) => ({ ...tool, input: jsonSchema(tool.input) }))
  const updated = replaceSection(
    replaceSection(original, "tools", renderTools(tools)),
    "cli-reference",
    "```text\n" + help + "\n```"
  )
  if (mode === "--update") writeFileSync(path, updated)
  else if (original !== updated) {
    process.stderr.write("README tool/CLI reference is stale. Run pnpm docs:generate.\n")
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
