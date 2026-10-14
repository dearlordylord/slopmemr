import { Schema } from "effect"
import { AbsolutePath } from "../local-state/contracts.js"

/** A local login-profile reference, never credential material. */
export const AuthReference = Schema.Union([
  Schema.Struct({ codexHome: AbsolutePath }),
  Schema.Struct({ claudeHome: AbsolutePath })
])
export type AuthReference = typeof AuthReference.Type

export const authRuntime = (auth: AuthReference): "codex" | "claude" => ("codexHome" in auth ? "codex" : "claude")
export const authHome = (auth: AuthReference): string => ("codexHome" in auth ? auth.codexHome : auth.claudeHome)
export const withAuthHome = (auth: AuthReference, home: string): AuthReference =>
  "codexHome" in auth ? { codexHome: home } : { claudeHome: home }
