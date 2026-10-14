import { execFile } from "node:child_process"
import { realpath } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { promisify } from "node:util"
import { Effect, Schema } from "effect"
import { projectIdentity } from "./identity.js"

const inventoryMaximumMebibytes = 4
const inventoryMaximumBytes = inventoryMaximumMebibytes * 1024 * 1024
const inventoryTimeoutMs = 5_000
const execute = promisify(execFile)

export class RootError extends Schema.TaggedError<RootError>()("RootError", { message: Schema.String }) {}

export { ProjectRoot } from "./contracts.js"

/** Caller supplies its project/launch root, never an edit's transient cwd. */
export const resolveRoot = Effect.fn("ProjectRoot.resolve")(function* (
  requested: string,
  legacyIdentity?: (path: string) => Promise<string | undefined>
) {
  if (!isAbsolute(requested) || requested.includes("\0")) {
    return yield* Effect.fail(new RootError({ message: "Project root must be an absolute directory" }))
  }
  return yield* Effect.tryPromise({
    try: async () => {
      const physical = await realpath(requested)
      // Git lists the primary working copy first, including when called in a linked
      // worktree. NUL porcelain preserves embedded newlines and Unicode paths.
      let output: string
      try {
        const result = await execute("git", ["-C", physical, "worktree", "list", "--porcelain", "-z"], {
          timeout: inventoryTimeoutMs,
          maxBuffer: inventoryMaximumBytes,
          env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined, LC_ALL: "C" }
        })
        output = result.stdout
      } catch (cause) {
        // Non-Git projects retain the explicitly supplied physical launch root.
        // Only Git's not-a-repository result is a valid fallback.
        if (isNonGitProject(cause)) {
          return { path: physical, key: await projectIdentity(physical, legacyIdentity) }
        }
        throw cause
      }
      const first = output.split("\0")[0]
      if (first === undefined || !first.startsWith("worktree ")) throw new Error("Invalid Git worktree inventory")
      const path = await realpath(first.slice("worktree ".length))
      return { path, key: await projectIdentity(path, legacyIdentity) }
    },
    catch: () => new RootError({ message: "Cannot resolve the calling agent's real project root" })
  })
})

const isNonGitProject = (cause: unknown): boolean =>
  cause instanceof Error &&
  "stderr" in cause &&
  typeof cause.stderr === "string" &&
  cause.stderr.includes("not a git repository")
