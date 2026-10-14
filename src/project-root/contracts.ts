import { Schema } from "effect"
import { AbsolutePath, Digest } from "../local-state/contracts.js"

export const ProjectRoot = Schema.Struct({ path: AbsolutePath, key: Digest })
export type ProjectRoot = typeof ProjectRoot.Type
