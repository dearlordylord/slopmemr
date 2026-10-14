export const help = `slopmemr — project memory for coding agents

  setup codex|claude [--profile PATH]
                                   Install hooks; the first hook starts memory automatically
  update codex|claude               Update the selected profile's installed runtime
  doctor codex|claude               Inspect registration without starting memory or inference
  uninstall codex|claude            Remove our hooks; preserve project memory
  roots                            List persisted project memory pools
  status --root PATH                Show coverage and compaction failures
  snapshot --root PATH [--before N] [--view main|compaction]
  zoom --root PATH --first N --count N [--page N]
  settle --root PATH [--wait-ms N]   Wait up to 20s; return the current snapshot
  stop                             Request graceful resident shutdown

Automation: append and request accept JSON on stdin. Hook/resident commands are internal.
Compaction uses the calling runtime's subscription: Codex/Luna or Claude/Haiku.
API keys and cross-runtime authentication fallback are unsupported.
`
