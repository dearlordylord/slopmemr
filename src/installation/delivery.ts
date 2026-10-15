import { Effect, Schema } from "effect"
import { Delivery, InstallationError, type DeliveryIntent, type Selection, type Snapshot } from "./contracts.js"
import { installationPaths } from "./binding.js"
import { readOptional, removeOptional } from "./files.js"
import { install } from "./manager.js"
import { withPublicCommand } from "./public-command.js"
import type { ProcessLaunch } from "../local-state/process-launch.js"

export const pendingDelivery = Effect.fn("Installation.pendingDelivery")(function* (selection: Selection) {
  return yield* Effect.try({
    try: () => {
      const text = readOptional(installationPaths(selection).delivery)
      return text === undefined ? undefined : Schema.decodeUnknownSync(Schema.fromJsonString(Delivery))(text)
    },
    catch: () => new InstallationError({ operation: "delivery", message: "Cannot inspect interrupted delivery" })
  })
})

/** The delivery journal outlives profile/public publication and activation. */
export const deliver = Effect.fn("Installation.deliver")(function* <E, R>(
  intent: DeliveryIntent,
  selection: Selection,
  source: ProcessLaunch,
  dataDirectory: string,
  native: (selection: Selection) => Effect.Effect<void, InstallationError>,
  activate: (action: DeliveryIntent["action"], snapshot: Snapshot) => Effect.Effect<void, E, R>
) {
  return yield* withPublicCommand(
    intent.publicDirectory,
    dataDirectory,
    install(selection, source, dataDirectory, intent.action === "Update", undefined, native, intent).pipe(
      Effect.map((owned) => owned.snapshot)
    ),
    undefined,
    (snapshot) =>
      Effect.gen(function* () {
        yield* activate(intent.action, snapshot)
        yield* Effect.try({
          try: () => removeOptional(installationPaths(selection).delivery),
          catch: () =>
            new InstallationError({
              operation: "delivery",
              message: "Activation succeeded; repeat repair to finalize delivery"
            })
        })
      })
  )
})
