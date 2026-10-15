import { expect, test } from "vitest"
import { failureToken, failureDetails } from "./failures.js"

test("explains native failures while discarding foreign messages and source content", () => {
  expect(failureDetails("Error: " + failureToken("No usable caller Claude profile selected"))).toMatchObject({
    reason: "authentication"
  })
  expect(failureDetails(failureToken("Codex compaction timed out"))).toMatchObject({ reason: "timeout" })
  expect(failureDetails(failureToken("Auth profile capacity reached"))).toMatchObject({ reason: "capacity" })
  expect(
    failureDetails(
      failureToken("Codex compaction failed; check profile, model availability, and protocol compatibility")
    )
  ).toMatchObject({ reason: "provider" })
  expect(failureDetails("credential /secret/token private source")).toMatchObject({ reason: "unknown" })
  expect(JSON.stringify(failureDetails("credential /secret/token private source"))).not.toContain("secret")
})
