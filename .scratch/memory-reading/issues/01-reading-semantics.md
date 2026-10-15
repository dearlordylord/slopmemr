# Семантика чтения UNII и ограничения транспорта

Parent: ../map.md
Type: research
Label: wayfinder:research
Status: resolved
Blocked by: none

## Question

Какие гарантии snapshot, zoom, границ, готовности и страниц задаёт UNII? Как hulymcp разделяет Effect MCP и транспорт, а ponytail доставляет небольшую инструкцию через SessionStart? Какие ограничения этих механизмов влияют на API?

## Assets

- [Исследование Астры](../../../docs/research/memory-reading-api.md) — уже подготовленные факты; не утверждение продуктового API.
- Нормативная спецификация: ../../../../unii/spec/MEMORY.md.

## Answer

Проверено 2026-10-14 по исходникам, в рамках research workflow. Фактическая часть прежней записки подтверждена; её «selected four-tool API», установка и предлагаемые коды ошибок остаются рекомендациями, а не решениями этой карты.

- **Snapshot:** `before` — исключающая граница записей, по умолчанию текущий `count`; `view` выбирает `main` или `compaction`, по умолчанию `main`. Оба представления покрывают непрерывный готовый префикс. `coveredThrough = min(before, cursor)`; `ready` означает полное покрытие запрошенного префикса, а не завершение всех родительских сжатий. `pending`/`failed` сохраняют адреса и покрытие, но `text` и `bytes` равны `null`. `failed` определяется неготовым листом с терминальной ошибкой до границы. При фиксированном `before` представление может меняться после слияний. [Контракт](../../../../unii/spec/MEMORY.md), [реализация](../../../../unii/src/memory.ts).
- **Дерево и zoom:** `{level: L, index: I}` соответствует диапазону `[I * 2^L, (I + 1) * 2^L)`. `count` — степень двойки, `first` кратен `count`, диапазон находится внутри записей; адрес проверяется на безопасные целые числа и `L <= 52`. При `count > 1` zoom возвращает ровно два построенных дочерних summary; отсутствие дочернего узла даёт `Unbuilt range`. Сам родитель может ещё не существовать. [Zoom](../../../../unii/src/memory.ts), [проверка адреса](../../../../unii/src/tree.ts).
- **Лист и страницы:** при `count = 1` возвращается исходный текст записи независимо от готовности summary. Страницы нумеруются с нуля, по умолчанию до 4 000 UTF-8 байт без разрыва кодовой точки; `totalBytes` относится ко всей записи. Пустая запись имеет одну пустую страницу. При `count > 1` нынешний UNII игнорирует `page` и возвращает `pages: 1`; отклонение ненулевой страницы адаптером было рекомендацией, не гарантией ядра. [Реализация и defaults](../../../../unii/src/memory.ts), [splitUtf8](../../../../unii/src/tree.ts).
- **Ограничение read-only:** методы чтения сами не добавляют записи, но нынешний slopmemr при lazy-open может создать identity/хранилище, обновить location и вызвать `memory.step()`, возобновив inference и запись производных данных. Это наблюдение об адаптере, не обязательное поведение snapshot в UNII. [MemoryManager](../../../src/memory/manager.ts), [контракт восстановления UNII](../../../../unii/spec/MEMORY.md).
- **Hulymcp:** регистрация инструментов через Effect MCP отделена от stdio/HTTP транспорта; CLI строится из общей операции и метаданных. Для stdio явно задерживается чтение до регистрации и координируется EOF, чтобы принятые ответы успели отправиться до закрытия scope. Успех кодируется одновременно как JSON-текст и `structuredContent: {result: ...}`. Это проверенные образцы реализации, не обязательная форма нашего будущего API. [Registry](../../../../hulymcp/src/mcp/effect-ai-registry.ts), [stdio](../../../../hulymcp/src/mcp/server.ts), [ответы](../../../../hulymcp/src/mcp/tool-responses.ts), [CLI](../../../../hulymcp/packages/huly-cli/src/command-tree.ts).
- **Ponytail:** для Codex SessionStart выводится JSON с `hookSpecificOutput.hookEventName` и `additionalContext`; native Claude SessionStart получает текст stdout. Ветка SubagentStart отличается. Комментарий активации учитывает повторный SessionStart после compaction. Это свидетельство стороннего исходника, не нормативная гарантия всех версий native hosts; живые проверки нашего guide здесь не выполнялись. [Hook runtime, pinned commit](https://github.com/DietrichGebert/ponytail/blob/2961b52fc1fe6a5a87c7a959a79512e5c2f3ffe5/hooks/ponytail-runtime.js), [activation](https://github.com/DietrichGebert/ponytail/blob/2961b52fc1fe6a5a87c7a959a79512e5c2f3ffe5/hooks/ponytail-activate.js).

Не определены этим исследованием: число/названия инструментов, транспортные обёртки и ошибки нашего API, способ подключения MCP, аннотации read-only и окончательный текст инструкции. Автоматическая подача snapshot, релевантный поиск и бюджет контекста исключены исходной постановкой карты, а не выводом из этих библиотек.
