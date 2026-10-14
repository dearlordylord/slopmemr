import { maximumSettleWaitMs } from "../memory/limits.js"

const mebibyte = 1024 * 1024
const maximumFrameMebibytes = 2
export const maxFrameBytes = mebibyte * maximumFrameMebibytes
export const frameDeadlineMs = 5_000
export const endpointProbeMs = 1_000
export const startupProbeMs = 500
export const maximumSocketBytes = 100
export const defaultConnectionLimit = 64
export const requestDeadlineMs = 30_000
export const settleClientDeadlineMs = maximumSettleWaitMs + frameDeadlineMs + frameDeadlineMs + frameDeadlineMs
export const startupDeadlineMs = 12_000
export const startupRetryCount = 100
export const startupRetryDelayMs = 100
export const residentProtocolVersion = 1
