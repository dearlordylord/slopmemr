# Установочный CLI и обслуживание по образцу hapsland

Parent: ../map.md
Type: research
Label: wayfinder:research
Status: closed — research and implementation complete; acceptance in docs/validation/memory-reading-review.md
Blocked by: none

## Question

Как устроены установка и обслуживание hapsland, какие пользовательские команды и гарантии переносим в slopmemr, что уже существует? Исследовать bootstrap/install/update/doctor/uninstall и обслуживание резидента; не переносить не относящиеся к памяти функции.

## Scope

User explicitly requires install CLI and maintenance features following hapsland. MCP registration is automatic for Claude and Codex. Preserve memory on removal and preserve unrelated host configuration.

## Answer

Исследование завершено 2026-10-14: [короткая записка с источниками](../../../docs/research/install-maintenance.md). `../jev/package.json` действительно определяет `@hapsland/hapsland`; проверены installation-workflows, обе host-инструкции, status и конкретные administration interpreters. Установка и inference не запускались.

- Hapsland разделяет получение/проверку пакета, регистрацию профилей и активацию shared resident. Его lifecycle включает setup/update/doctor/repair/reinstall/uninstall; resident-only update сохраняет target, заменяет другой serving build и проверяет результат. Ошибка запуска оставляет target и partial state. [Resident update](../../../../jev/packages/administration/src/onboarding/resident-update.ts), [commands](../../../../jev/packages/administration/src/onboarding/client-command.ts).
- slopmemr уже имеет setup (`install` — alias), update, doctor, uninstall, stop и автоматический старт. dev-install публикует стабильную CLI-команду после сборки и doctor. Обычный update использует текущий immutable bundle: он не приобретает новый пакет и не переключает работающий resident. [Program](../../../src/cli/program.ts), [bootstrap](../../../scripts/dev-install.mjs), [contract](../../../docs/installation.md).
- Минимальное предложение: сохранить существующий lifecycle, добавить repair для отсутствующих exact-owned bindings/валидного журнала и явно определить restart. Setup автоматически регистрирует hooks и MCP, как уже потребовал пользователь. Отдельный force-reinstall, review rules, credentials UI, dashboard и release channels не следуют из задачи и не предлагаются как обязательные.
- Doctor остаётся пассивным; update различает выбранную и реально serving сборку. Удаление убирает только owned hooks/MCP и профильные launcher, сохраняет память и чужие настройки. Все launcher должны согласованно выбирать общий resident target, иначе старый профиль может запустить старую сборку после остановки.
- Два существенных выбора для спецификации: откуда end user получает первый/новый пакет и активирует ли update resident сразу либо оставляет явный restart. Записка рекомендует минимальный staged update + graceful restart, но не утверждает это продуктовым решением. Native host reconnect/trust остаётся отдельным от restart резидента действием.
