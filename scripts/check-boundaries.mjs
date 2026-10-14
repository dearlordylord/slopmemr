import { parse } from "@babel/parser"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sourceRoot = join(root, "src")
const allowed = {
  "project-root": ["local-state"],
  "local-state": [],
  compaction: ["local-state"],
  memory: ["compaction", "project-root", "local-state"],
  resident: ["memory", "local-state", "project-root"],
  intake: ["memory", "compaction"],
  installation: ["intake", "local-state"],
  cli: ["resident", "memory", "compaction", "intake", "project-root", "local-state", "installation"]
}

const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === "fixtures" ? [] : walk(path)
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : []
  })

const imports = (source) => {
  const output = []
  const visit = (node) => {
    if (node === null || typeof node !== "object") return
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source)
      output.push(node.source.value)
    if (node.type === "ImportExpression" || (node.type === "CallExpression" && node.callee?.type === "Import")) {
      const argument = node.source ?? node.arguments[0]
      if (argument?.type !== "StringLiteral")
        throw new Error("Nonliteral dynamic import bypasses capability boundaries")
      output.push(argument.value)
    }
    if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "require") {
      if (node.arguments[0]?.type !== "StringLiteral")
        throw new Error("Nonliteral require bypasses capability boundaries")
      output.push(node.arguments[0].value)
    }
    if (node.type === "TSExternalModuleReference") output.push(node.expression.value)
    if (node.type === "TSImportType" && node.source?.type === "StringLiteral") output.push(node.source.value)
    for (const [key, child] of Object.entries(node)) {
      if (["loc", "start", "end", "extra", "comments", "tokens"].includes(key)) continue
      if (Array.isArray(child)) child.forEach(visit)
      else if (typeof child === "object") visit(child)
    }
  }
  visit(parse(source, { sourceType: "module", plugins: ["typescript"] }))
  return [...new Set(output)]
}

export const checkBoundaries = (sources) => {
  const edges = new Map()
  const external = new Map()
  const violations = []
  for (const [file, source] of sources) {
    const owner = file.split("/")[0]
    edges.set(file, [])
    external.set(file, [])
    for (const specifier of imports(source)) {
      if (!specifier.startsWith(".")) {
        if (specifier.startsWith("/") || specifier.startsWith("file:") || specifier.startsWith("#"))
          violations.push(`${file}: local modules must use relative imports (${specifier})`)
        external.get(file).push(specifier)
        continue
      }
      const target = relative("/src", resolve("/src", dirname(file), specifier))
        .replace(/\.js$/, ".ts")
        .replaceAll("\\", "/")
      if (!sources.has(target)) {
        violations.push(`${file}: undeclared local source ${specifier}`)
        continue
      }
      edges.get(file).push(target)
      const targetOwner = target.split("/")[0]
      if (owner !== "index.ts" && owner !== targetOwner && !allowed[owner]?.includes(targetOwner)) {
        violations.push(`${file}: ${owner} must not depend on ${targetOwner} (${target})`)
      }
    }
  }
  const completed = new Set()
  const active = new Set()
  const visitCycle = (file, trail) => {
    if (active.has(file)) {
      violations.push(`Dependency cycle: ${[...trail, file].join(" -> ")}`)
      return
    }
    if (completed.has(file)) return
    active.add(file)
    for (const target of edges.get(file) ?? []) visitCycle(target, [...trail, file])
    active.delete(file)
    completed.add(file)
  }
  for (const file of sources.keys()) visitCycle(file, [])
  // Exact client/intake closures must stay free of persistence and execution.
  for (const entry of ["resident/client.ts", "intake/hook.ts"]) {
    const seen = new Set()
    const visit = (file) => {
      if (seen.has(file)) return
      seen.add(file)
      for (const specifier of external.get(file) ?? []) {
        if (["node:sqlite", "node:child_process", "@firfi/unii", "@effect/platform-node"].includes(specifier)) {
          violations.push(`${entry}: restricted closure reaches ${specifier} through ${file}`)
        }
      }
      for (const target of edges.get(file) ?? []) visit(target)
    }
    if (sources.has(entry)) visit(entry)
  }
  return violations
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8"))
  if (Object.keys(config.compilerOptions?.paths ?? {}).length !== 0)
    throw new Error("Path aliases require explicit capability-graph resolution before adoption")
  const sources = new Map(
    walk(sourceRoot).map((path) => [relative(sourceRoot, path).replaceAll("\\", "/"), readFileSync(path, "utf8")])
  )
  const violations = checkBoundaries(sources)
  if (violations.length) {
    process.stderr.write(violations.join("\n") + "\n")
    process.exitCode = 1
  } else process.stdout.write(`Capability boundaries checked (${sources.size} modules, including type-only imports)\n`)
}
