import { join } from "node:path"
import { Effect, Schema } from "effect"
import {
  RuntimeSelection,
  RuntimeTarget,
  readSelection,
  selectionPath,
  selectionFiles
} from "../local-state/runtime-selection.js"
import { privateDirectory } from "../local-state/private-directory.js"
import { exclusive, writeAtomic } from "./files.js"
import { InstallationError } from "./contracts.js"
import type { Snapshot } from "./contracts.js"

export const selectRuntime = Effect.fn("Installation.selectRuntime")(function* <
  A extends { readonly serving: boolean },
  E,
  R
>(snapshot: Snapshot, activate: (selected: RuntimeSelection) => Effect.Effect<A, E, R>) {
  const directory = snapshot.dataDirectory
  if (directory === undefined)
    return yield* Effect.fail(
      new InstallationError({
        operation: "select-runtime",
        message: "Update the legacy installation before selecting its runtime"
      })
    )
  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* ownSelection(directory)
      const selected = yield* Effect.try({
        try: () => {
          const previous = readSelection(directory, selectionFiles)
          const selected = RuntimeSelection.make({
            application: "slopmemr",
            version: 1,
            launch: snapshot.launch,
            implementation: snapshot.digest,
            dataDirectory: directory
          })
          const retained = priorTarget(previous, selected)
          const next = RuntimeSelection.make({ ...selected, ...(retained === undefined ? {} : { previous: retained }) })
          if (JSON.stringify(previous) !== JSON.stringify(next))
            writeAtomic(selectionPath(directory), JSON.stringify(next) + "\n")
          return next
        },
        catch: selectionFailure
      })
      const activation = yield* activate(selected)
      if (activation.serving)
        yield* Effect.try({
          try: () =>
            writeAtomic(
              selectionPath(directory),
              JSON.stringify(Schema.decodeUnknownSync(RuntimeTarget)(selected)) + "\n"
            ),
          catch: selectionFailure
        })
      return { selected, activation }
    })
  )
})

const selectionFailure = () =>
  new InstallationError({ operation: "select-runtime", message: "Cannot safely select the shared resident build" })

const priorTarget = (previous: RuntimeSelection | undefined, selected: RuntimeSelection): RuntimeTarget | undefined => {
  if (previous === undefined) return undefined
  if (previous.previous !== undefined) return previous.previous
  const target = Schema.decodeUnknownSync(RuntimeTarget)(previous)
  return JSON.stringify(target) === JSON.stringify(selected) ? previous.previous : target
}

export const ownSelection = Effect.fn("Installation.ownSelection")(function* (directory: string) {
  const runtime = join(directory, "runtime")
  yield* Effect.try({ try: () => privateDirectory(runtime), catch: selectionFailure })
  yield* exclusive(runtime, join(runtime, "selection-owner.sqlite"))
})
