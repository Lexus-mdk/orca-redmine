// Samples mimic what Redmine issues usually hold.
import { assert, test } from 'orca/testing'
import { markdownWithIssueLinks, textileToMarkdown } from './textile'

const ctx = { baseUrl: 'https://rm.test', attachments: { 'scan.png': 'https://rm.test/attachments/download/7/scan.png' } }
const md = (text: string) => textileToMarkdown(text, ctx)

test('headings drop one level for the sidebar', () => {
  assert.equal(md('h2. Проблема\r\n\r\nТекст'), '### Проблема\n\nТекст')
  assert.equal(md('h3. 1. Извлечение (OpenRouter)'), '#### 1. Извлечение (OpenRouter)')
})

test('inline code keeps snake_case and asterisks intact', () => {
  assert.equal(
    md('с включённым @FEATURE_PREVIEW_ENABLED=1@ и @memory: 6G@ без @memswap_limit@'),
    'с включённым `FEATURE_PREVIEW_ENABLED=1` и `memory: 6G` без `memswap_limit`'
  )
  assert.equal(md('поле order_request_items.segment_name'), 'поле order_request_items.segment_name')
  assert.equal(md('почта dev@example.com'), 'почта dev@example.com')
})

test('bold, italic and strike follow Textile word boundaries', () => {
  assert.equal(md('один документ — *3,65 ГБ RSS* в воркере'), 'один документ — **3,65 ГБ RSS** в воркере')
  assert.equal(md('*Спорно, решить с заказчиком:* блок'), '**Спорно, решить с заказчиком:** блок')
  assert.equal(md('это _важно_ и -устарело- тоже'), 'это *важно* и ~~устарело~~ тоже')
  assert.equal(md('ТУ 1234-001-12345678-2020'), 'ТУ 1234-001-12345678-2020')
})

test('lists start even right under a paragraph line and nest', () => {
  assert.equal(
    md('Почему:\r\n* первое;\r\n** вложенное\r\n* второе'),
    'Почему:\n\n- первое;\n   - вложенное\n- второе'
  )
  assert.equal(md('# Раз\r\n# Два'), '1. Раз\n1. Два')
  assert.equal(md('Решения\r\n- заявка : сущность\r\n- права : группы'), 'Решения\n\n- заявка : сущность\n- права : группы')
})

test('single newlines inside a paragraph are hard breaks', () => {
  assert.equal(md('строка один\r\nстрока два'), 'строка один\\\nстрока два')
})

test('issue references become links, but not inside code or at list starts', () => {
  assert.equal(
    md('#14222, #14486 — вердикт; @#15000@'),
    '[#14222](https://rm.test/issues/14222), [#14486](https://rm.test/issues/14486) — вердикт; `#15000`'
  )
})

test('pre blocks become fences and are left alone', () => {
  const source = 'Текст:\r\n<pre>\r\nif not parsed and not items:\r\n    return None if *a* else {}\r\n</pre>\r\nдальше'
  assert.equal(
    md(source),
    'Текст:\n\n```\nif not parsed and not items:\n    return None if *a* else {}\n```\n\nдальше'
  )
  assert.equal(md('<pre><code class="php">$a = 1;</code></pre>'), '```php\n$a = 1;\n```')
})

test('quotes, links, images and tables', () => {
  assert.equal(md('bq. Наименование должно\r\nбыть таким же'), '> Наименование должно\\\n> быть таким же')
  assert.equal(md('см. "документацию":https://ex.com/a_b.'), 'см. [документацию](https://ex.com/a_b).')
  assert.equal(md('"почта":mailto:a@b.ru'), '[почта](mailto:a@b.ru)')
  assert.equal(md('!scan.png!'), '[🖼 scan.png](https://rm.test/attachments/download/7/scan.png)')
  assert.equal(md('!other.jpg!'), '🖼 other.jpg')
  assert.equal(
    md('|_. Поле |_. Было |\r\n| дата | null |'),
    '| Поле | Было |\n| --- | --- |\n| дата | null |'
  )
  assert.equal(md('| а | б |'), '|  |  |\n| --- | --- |\n| а | б |')
})

test('markdown Redmines get issue links only', () => {
  assert.equal(
    markdownWithIssueLinks('см. #12 и `#13`', ctx),
    'см. [#12](https://rm.test/issues/12) и `#13`'
  )
})
