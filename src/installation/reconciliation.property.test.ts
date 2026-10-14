import { expect, it } from "vitest"
import fc from "fast-check"
import { configurationText, ownedGroup, reconcile } from "./reconciliation.js"
import type { Configuration } from "./reconciliation.js"

const command = "'/bin/sh' '/profile/.slopmemr/codex/hook-launcher.sh' --hook-owner slopmemr-hook-owner-1"
const foreignCommand = fc.string().map((text) => `foreign:${text}`)
const foreignGroup = foreignCommand.map((command) => ({ hooks: [{ type: "command", command }] }))

it("setup is idempotent and uninstall preserves arbitrary unrelated settings and handler order", () => {
  fc.assert(
    fc.property(
      fc.dictionary(
        fc.string().filter((key) => key !== "hooks"),
        fc.jsonValue()
      ),
      fc.array(foreignGroup),
      (settings, groups) => {
        const initial: Configuration = { ...settings, hooks: { Stop: groups, UnknownEvent: groups } }
        const installed = reconcile(initial, command, true)
        expect(configurationText(reconcile(installed, command, true, true))).toBe(configurationText(installed))
        const removed = reconcile(installed, command, false, true)
        const expected = groups.length === 0 ? { ...settings, hooks: { UnknownEvent: [] } } : initial
        expect(removed).toEqual(expected)
      }
    ),
    { numRuns: 200 }
  )
})

it("existing owned entries retain their position and accept reordered object keys", () => {
  fc.assert(
    fc.property(fc.array(foreignGroup), fc.array(foreignGroup), (before, after) => {
      const reversed = { hooks: [{ timeout: 30, command, type: "command" }] }
      const initial: Configuration = {
        hooks: Object.fromEntries(
          ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SubagentStop"].map((event) => [
            event,
            [...before, reversed, ...after]
          ])
        )
      }
      expect(reconcile(initial, command, true, true)).toEqual(initial)
    }),
    { numRuns: 100 }
  )
})

it("owned handler mutations are rejected without mutating the original configuration", () => {
  fc.assert(
    fc.property(
      fc.integer().filter((timeout) => timeout !== 30),
      (timeout) => {
        const initial: Configuration = { hooks: { Stop: [{ hooks: [{ type: "command", command, timeout }] }] } }
        const before = configurationText(initial)
        expect(() => reconcile(initial, command, false)).toThrow()
        expect(configurationText(initial)).toBe(before)
      }
    ),
    { numRuns: 100 }
  )
  expect(() => reconcile({ hooks: { Stop: [ownedGroup(command), ownedGroup(command)] } }, command, true)).toThrow()
})
