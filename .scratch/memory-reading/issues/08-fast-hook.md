# Быстрый хук без загрузки резидента

Parent: ../map.md
Type: research
Label: wayfinder:research
Status: closed — research and implementation complete; acceptance in docs/validation/memory-reading-review.md
Blocked by: none

## Question

Как перенести границу standalone hook из hapsland: отдельный установленный артефакт, который не загружает resident/storage/compactor/MCP implementation? Какие зависимости текущего slopmemr действительно попадают в запускаемый хук, каковы минимальные изменения композиции и какие проверки подтверждают границу и скорость?

## User requirement

Hook must be fast and must not load the whole resident, following hapsland. Resident startup is independent of hook code loading; no provider work may be awaited by the hook.

## Observed baseline

scripts/build.mjs currently bundles only src/cli/main.ts into slopmemr.mjs. The profile launcher invokes that general CLI with hook mode, whose program statically imports memory, compactor, installation and resident server. Existing restrictions on intake/hook.ts and resident/client.ts alone do not constrain the actual hook executable's dependency closure.

## Answer

Нужен отдельный установленный `slopmemr-hook.mjs`: только native input → нормализация → transport/start отдельного resident → durable append → native output. Сейчас launcher запускает общий CLI; его static imports включают resident/storage/compactors/install, поэтому проверки client/intake не защищают реальный executable.

Минимум: два независимых bundle, узкая hook composition/config, manifest с digest обоих артефактов и отдельными hook/resident launch roles, установка/doctor/recovery проверяют пару. Общий CLI пока может остаться resident/control executable. Доказательства: source closure реального hook entry + build metafile + installed launcher test; отдельная проверка, что hook заканчивается при заблокированном fake compactor.

Предложенный budget (ещё не достигнут и требует принятия): 4 KiB событие, installed launcher → durable ack/exit; warm p95 ≤ 150 ms, fresh resident p95 ≤ 2 s, unavailable deadline ≤ 3 s. Измерять warm/fresh отдельно, сохранять failures и artifact hashes; fresh process не означает cold filesystem cache.

Safe baseline только общего CLI `--help`: 20 запусков, median 75.21 ms, p95 88.66 ms, Node 24 Linux arm64. Это НЕ hook latency. Никаких install/hook/provider вызовов; build не выполнялся.

Подробности и первичные ссылки: [fast-hook research](../../../docs/research/fast-hook.md).
