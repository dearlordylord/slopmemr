import { expect, test } from "vitest"
import { Schema } from "effect"
import { AvailableZoom, zoomFailure, MemoryReadError } from "./reading.js"
test("maps native zoom failures to stable public errors", () => {
  const own = new MemoryReadError({ code: "INVALID_PAGE", message: "page", retryable: false })
  expect(zoomFailure(own)).toBe(own)
  expect(zoomFailure(new Error("Invalid page")).code).toBe("INVALID_PAGE")
  expect(zoomFailure(new Error("Unbuilt range")).code).toBe("RANGE_NOT_READY")
  expect(zoomFailure(new Error("private data")).message).toBe("Project memory is unavailable")
  expect(zoomFailure(undefined).retryable).toBe(false)
})

test("rejects contradictory child readiness on the wire", () => {
  const processing = { state: "idle", active: 0, pending: 0, failed: [], storageAvailable: true }
  const result = (state: string, text: string | null) => ({
    kind: "children",
    first: 0,
    count: 2,
    processing,
    children: [
      { first: 0, count: 1, state, text },
      { first: 1, count: 1, state: "pending", text: null }
    ]
  })
  expect(() => Schema.decodeUnknownSync(AvailableZoom)(result("ready", null))).toThrow()
  expect(() => Schema.decodeUnknownSync(AvailableZoom)(result("failed", "invented"))).toThrow()
  expect(Schema.decodeUnknownSync(AvailableZoom)(result("ready", "retained"))).toMatchObject({ kind: "children" })
})
