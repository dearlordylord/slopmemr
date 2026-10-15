# Discoverability MCP по образцу hulymcp

Parent: ../map.md
Type: research
Label: wayfinder:research
Status: closed — research and implementation complete; acceptance in docs/validation/memory-reading-review.md
Blocked by: none

## Question

Как перенести progressive discovery hulymcp для каталога чтения slopmemr: поиск инструментов, получение схемы и вызов? Какие host-specific различия существенны и какой минимальный слой нужен? Пользователь явно требует discoverability по образцу hulymcp; это не список сохранённых проектов.

## Subsequent user clarification

Tool search is unnecessary for the small reading surface. The user wants schemas immediately. Research findings about hulymcp describe the reference implementation, not the chosen slopmemr design. Publish direct reading tools with complete schemas; no progressive-discovery proxy layer.

## Assets

- ../../../../hulymcp/src/mcp/proxy-tools.ts
- ../../../../hulymcp/src/mcp/proxy-tool-catalog.ts
- [Исследование доступной памяти и discovery](../../../docs/research/available-memory-reading.md).

## Answer

Проверено по исходникам 2026-10-14 через research workflow. Это исследовательский ответ, не утверждение конкретного API slopmemr.

- Hulymcp в proxy mode предоставляет `list_tool_categories`, `search_tools`, `get_tool_schema`, `invoke_tool`. Поиск возвращает имена/описания и обязательные/необязательные параметры; схема раскрывает полный контракт одной операции; invoker вызывает её через общий валидируемый registry. Схемы не устанавливают новые MCP tools динамически. Зная имя и аргументы, можно сразу вызывать операцию. [Proxy](../../../../hulymcp/src/mcp/proxy-tools.ts).
- Поиск работает по метаданным инструментов, категориям и именам параметров, не по содержимому памяти и не по сохранённым проектам. [Catalog](../../../../hulymcp/src/mcp/proxy-tool-catalog.ts).
- Auto mode выбирает native для точного имени клиента `claude-code`, proxy для Codex и большинства остальных клиентов. Scope native-каталога и proxy-кандидатов определяется отдельно; по умолчанию proxy может иметь весь registry. Для slopmemr нельзя случайно передать invoker административные операции резидента. Это устройство Hulymcp, не требование воспроизвести все режимы. [Mode](../../../../hulymcp/src/mcp/tool-mode.ts), [exposure](../../../../hulymcp/src/mcp/protocol-tool-exposure.ts).
- Для маленького каталога технически достаточно общего registry и двух фасадов: discovery с кратким каталогом либо полной схемой выбранной операции, и invoke. Это сохраняет постепенное раскрытие. Если требуется буквально протокол Hulymcp, нужны его четыре proxy-операции; если требуется отдельный поиск, его следует сохранить. Число и имена здесь не выбраны — это остаётся в продуктовом контракте.

В [записке](../../../docs/research/available-memory-reading.md) отдельно показано, что доступный префикс получается обычным UNII snapshot до `coveredThrough`, а свежесть и состояние фоновых задач имеют разные оси. `Memory.date` даёт время приёма записи, не время исходного события или создания summary. Pending без active не означает выполняющийся inference; active может включать ожидание backend admission; родительское сжатие не означает неполное покрытие записей.
