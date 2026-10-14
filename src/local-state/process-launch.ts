import { Schema } from "effect"
import { AbsolutePath } from "./contracts.js"

export const ProcessLaunch = Schema.Struct({ executable: AbsolutePath, entrypoint: AbsolutePath })
export type ProcessLaunch = typeof ProcessLaunch.Type

export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
export const launchCommand = (launch: ProcessLaunch): string =>
  `${shellQuote(launch.executable)} ${shellQuote(launch.entrypoint)}`
