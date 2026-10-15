# Контракт чтения памяти для агента

Parent: ../map.md
Type: grilling
Label: wayfinder:grilling
Status: closed — research and implementation complete; acceptance in docs/validation/memory-reading-review.md
Assignee: /root
Blocked by: 01

## Question

Какой контракт MCP/CLI даёт агенту доступную память, навигацию и правдивый статус во время фоновой обработки?

## Confirmed user decisions

- Возвращать имеющуюся память сразу со статусом и свежестью; если её нет — пустой текст со статусом. Незавершённая суммаризация сама по себе не ошибка.
- Фоновая компакция продолжается, запрос чтения её не ждёт.
- Zoom возвращает готовую часть, явно обозначая неготовую дочернюю сводку; не ждёт обеих.
- MCP сразу публикует конкретные инструменты с полными схемами. Поиск инструментов, отдельный schema-fetch и invoke proxy не нужны.

## Concrete contract for review

| MCP operation | CLI | Meaning |
| --- | --- | --- |
| slopmemr_snapshot | snapshot | Доступная сводка с фактическим покрытием, датами и обработкой. |
| slopmemr_zoom | zoom | Две дочерние сводки или страница исходной записи. |
| slopmemr_status | status | Состояние памяти без текста. |
| slopmemr_roots | roots | Сохранённые проекты и их последние известные пути. |

Все чтения проекта явно указывают абсолютный root и используют существующую устойчивую идентичность проекта. Нет выбора последнего посещённого проекта или зависимости от cwd процесса MCP. Roots — помощь при навигации между сохранёнными пулами; известный корень не требует предварительного вызова.

Snapshot before исключает запись с этим ID; по умолчанию граница фиксируется на текущем count. В одном синхронном обработчике резидента получаем запрошенное покрытие и готовый префикс. Текст и адреса относятся только к реальному префиксу. При coveredThrough=0 текст пустой. Отдельно показываем totalRecords.

Даты — время приёма записей с ID requestedThrough-1 и coveredThrough-1, либо null при нуле/невалидной дате. Это не время генерации сводки и не максимальный timestamp. Полнота покрытия независима от работы над родительскими сводками. Processing показывает active/pending/failed всего пула; state updating/waiting/idle описывает наблюдаемую активность, не обещает доступность провайдера или определённую scheduler eligibility.

Zoom count>1 возвращает ровно два стабильных адресованных child slots с готовым текстом либо явной неготовностью. count=1 читает исходную запись независимо от готовности её сводки. Диапазон выровнен по бинарному дереву; page ненулевой разрешён только для исходной записи. Пагинация сохраняет UTF-8 символы.

MCP и CLI разделяют схемы и обработку. Доступная память при ошибке компактора остаётся успешным результатом с диагностическим статусом. Неверный запрос, недоступный транспорт и нечитабельное хранилище остаются настоящими ошибками. Внутреннюю семантику UNII не меняем ради внешнего формата.

## Assets

- [Спецификация](../spec.md)
- [Исследование UNII API](../../../docs/research/memory-reading-api.md)
- [Исследование доступного префикса](../../../docs/research/available-memory-reading.md)

## Comments

Продуктовые ответы получены от пользователя; этот консолидированный контракт готов для окончательной сверки. Source implementation остаётся приостановленной; schema/field names — конкретные инженерные решения для review, а не утверждение уже работающего API.

## Answer

User decisions establish available-memory reads, background processing, partial zoom and direct MCP schemas. The final contract and tiny SessionStart guide are consolidated in [the specification](../spec.md). The separate hook/acceptance question had no independent remaining product choice and was consolidated here. Research and decisions are complete; implementation is a separate workflow and has not yet been validated.
