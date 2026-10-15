# Подключение MCP к Claude и Codex

Parent: ../map.md
Type: grilling
Label: wayfinder:grilling
Status: resolved
Assignee: /root
Blocked by: none

## Question

Подключаем ли MCP автоматически в существующем процессе установки или сначала выдаём ручную конфигурацию? Каков необходимый контракт обновления и удаления регистрации при сохранении чужих настроек?

## Proposal

Автоматическое подключение с проверкой владения записью и сохранением чужих настроек. Вопрос задан пользователю, ответа пока нет.

## User answer

Confirmed: automatically register MCP during installation for Claude and Codex, preserving foreign settings. User additionally requires an installation CLI and maintenance features following hapsland; investigate the relevant minimal lifecycle surface before finalizing the specification.

## Research result and proposed maintenance

[Hapsland lifecycle investigation](../../../docs/research/install-maintenance.md) identifies install/setup, update, doctor, repair, uninstall, restart and stop as a small useful surface. Existing install/update lacks package acquisition, MCP registration and central selected-target coordination. A retained old profile must not restart an old resident after update.

Two remaining product choices have been asked: ordinary acquisition through a ready-made package versus source checkout, and immediate activation on update versus staged activation with explicit restart. No implementation is authorized by this research ticket itself.

## Answer

The user confirmed automatic selected-profile MCP registration, ready-made package installation and immediate graceful resident activation on update. Development source builds remain a separate dev-install route. Installation and maintenance follow hapsland's package/registration/resident distinction, preserving memory and foreign native settings.

The chosen lifecycle specification includes install/setup, update, doctor, repair, uninstall, restart and stop. Hook and MCP registration are separately owned/recoverable units. All installed launchers resolve the same durable resident selection; older profiles must not revive an obsolete build. Activation verifies the selected build is serving, or reports recoverable partial success.

Publication is a separate delivery task; confirmation of the package route is not a claim that a public distribution exists. Runtime/platform prerequisites must be checked before changing native registration. Detailed contracts are in [the specification](../spec.md#install-and-maintenance).

The user additionally confirmed including the runtime in the ready-made package, so ordinary users need no separately installed Node.
