// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { chunks } from './chunks'
import * as panel from './panel'
import type { RedmineDetails, RedmineIssue, RedmineSnapshot } from './protocol'

// Redmine lists "В работе" before "Новая", although its id is larger.
const STATUSES = [
  { id: 2, name: 'В работе', closed: false },
  { id: 1, name: 'Новая', closed: false },
  { id: 5, name: 'Закрыта', closed: true }
]

const issue = (id: number, statusId: number, workspaceId: string | null = null): RedmineIssue => ({
  id,
  subject: `Задача ${id}`,
  project: 'Демо-проект',
  tracker: 'Ошибка',
  status: STATUSES.find((s) => s.id === statusId)?.name ?? '',
  statusId,
  priority: 'Нормальный',
  author: 'Автор',
  // The number looked up from the search box is someone else's, unassigned issue.
  assignee: id === 13871 ? '' : 'Смирнова Анна',
  doneRatio: 0,
  updatedAt: 0,
  url: `https://redmine.test/issues/${id}`,
  workspaceId
})

const details = (id: number, statusId = 2, workspaceId: string | null = null): RedmineDetails => ({
  issue: issue(id, statusId, workspaceId),
  parent: null,
  subtasks: [],
  description: '### Проблема\n\nТекст описания',
  comments: [
    { id: 2, author: 'Смирнова', createdAt: 0, private: true, text: 'Второй **комментарий**' },
    { id: 1, author: 'Петров', createdAt: 0, private: false, text: 'Первый комментарий' }
  ],
  commentsTotal: 2,
  attachments: 0,
  allowedStatuses: STATUSES
})

const SNAPSHOT: RedmineSnapshot = {
  user: 'Анна Смирнова',
  issues: [issue(14605, 2, 'ws-14605'), issue(14700, 1)],
  fetchedAt: 0
}

const configuredRequests = {
  'redmine.state': () => ({ configured: true, hasKey: true, baseUrl: 'https://redmine.test' }),
  'redmine.issues': () => SNAPSHOT,
  'redmine.statuses': () => ({ statuses: STATUSES }),
  'redmine.details': ({ id }: { id: number }) =>
    details(id, id === 14605 ? 2 : 1, id === 14605 ? 'ws-14605' : null)
}

let view: TestPanel | undefined
afterEach(() => view?.unmount())

test('asks for an address and a key first and shows the list once Redmine accepts them', async () => {
  let configured = false
  const sent: { baseUrl: string; key?: string }[] = []
  const host = mockHost({
    requests: {
      'redmine.state': () => ({ configured, hasKey: false, baseUrl: '' }),
      'redmine.connect': (input) => {
        sent.push(input)
        configured = true
        return { user: 'Анна Смирнова', baseUrl: 'https://redmine.test' }
      },
      'redmine.issues': () => SNAPSHOT,
      'redmine.statuses': () => ({ statuses: STATUSES })
    }
  })
  view = await mount(panel, { host })
  // A key alone is not enough: the address comes first.
  await view.type({ label: 'API-ключ' }, 'k1', { submit: true })
  assert.deepEqual(sent, [])
  await view.type({ label: 'Адрес Redmine' }, 'redmine.test')
  assert.ok(view.find({ text: 'https://redmine.test/my/account' }))
  await view.press({ role: 'button', text: 'Подключить' })
  assert.deepEqual(sent, [{ baseUrl: 'redmine.test', key: 'k1' }])
  assert.ok(view.find({ text: /Подключено к https:\/\/redmine\.test/ }))
  assert.ok(view.find({ label: '#14605 Задача 14605' }))
  assert.ok(view.find({ label: 'Новая · 1' }))
  assert.equal(view.find({ label: 'API-ключ' }), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
})

test('each issue in the list sits in its own bordered box, the open one highlighted', async () => {
  view = await mount(panel, { host: mockHost({ requests: configuredRequests }) })
  const boxes = view.findAll({ type: 'Box' }).filter((b) => /#\d+ Задача/.test(b.text))
  assert.equal(boxes.length, 2)
  assert.ok(boxes.every((b) => b.props.border === true))

  await view.press({ label: '#14700 Задача 14700' })
  const open = view
    .findAll({ type: 'Box' })
    .find((b) => b.props.border === 'accent' && /#14700 Задача 14700/.test(b.text))
  assert.ok(open)
  assert.deepEqual(view.warnings, [])
})

test('the card loads the description and comments, newest first', async () => {
  view = await mount(panel, { host: mockHost({ requests: configuredRequests }) })
  await view.press({ label: '#14605 Задача 14605' })
  assert.ok(view.find({ label: 'Описание' }))
  assert.ok(view.find({ text: /Текст описания/ }))
  assert.ok(view.find({ label: 'Комментарии · 2' }))
  const fields = view.find({ type: 'KeyValue' })?.props.items as { label: string; value: unknown }[]
  assert.equal(fields.find((f) => f.label === 'Исполнитель')?.value, 'Смирнова Анна')
  const texts = view
    .findAll({ type: 'Markdown' })
    .map((m) => String(m.props.content))
    .filter((c) => c.includes('омментарий'))
  assert.deepEqual(texts, ['Второй **комментарий**', 'Первый комментарий'])
  assert.ok(view.find({ text: 'приватный' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
})

test('the card shows the parent and nested subtasks, and both open their own card', async () => {
  const family = (id: number): RedmineDetails =>
    id === 14605
      ? {
          ...details(14605, 2, 'ws-14605'),
          parent: { id: 14462, subject: 'Личный кабинет', status: 'Новая' },
          subtasks: [
            { id: 16001, subject: 'Бэкенд', tracker: 'Разработка', status: 'В работе', closed: false, assignee: 'Иванов', doneRatio: 0, depth: 1 },
            { id: 16002, subject: 'Миграция', tracker: 'Разработка', status: 'Закрыта', closed: true, assignee: '', doneRatio: 100, depth: 2 }
          ]
        }
      : details(id, 1)
  view = await mount(panel, {
    host: mockHost({ requests: { ...configuredRequests, 'redmine.details': ({ id }) => family(id) } })
  })
  await view.press({ label: '#14605 Задача 14605' })
  assert.ok(view.find({ text: /Родительская: #14462 Личный кабинет · Новая/ }))
  assert.ok(view.find({ label: 'Подзадачи · закрыто 1 из 2' }))
  assert.ok(view.find({ label: '#16002 Миграция' }))
  assert.equal(view.find({ label: '#16001 Бэкенд' })?.props.description, 'В работе · Иванов · Разработка')
  assert.equal(view.find({ label: '#16002 Миграция' })?.props.icon, 'check')
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.errors, [])

  await view.press({ label: '#16001 Бэкенд' })
  assert.ok(view.find({ text: /#16001 Задача 16001/ }))
  assert.equal(view.find({ label: /^Подзадачи/ }), null)
  assert.deepEqual(view.refusals, [])
})

test('filters, opens a card and starts an agent', async () => {
  const started: number[] = []
  const host = mockHost({
    requests: {
      ...configuredRequests,
      'redmine.start': ({ id }) => {
        started.push(id)
        return { workspace: '14605', prompt: `/task-continue ${id}`, created: false }
      }
    }
  })
  view = await mount(panel, { host })
  await view.type({ label: 'Поиск' }, '700')
  assert.equal(view.find({ label: '#14605 Задача 14605' }), null)
  assert.ok(view.find({ label: '#14700 Задача 14700' }))

  await view.type({ label: 'Поиск' }, '', { replace: true })
  await view.press({ label: '#14605 Задача 14605' })
  await view.press({ role: 'button', text: 'Продолжить' })
  assert.deepEqual(started, [14605])
  assert.ok(view.find({ text: /Агент запущен в «14605»/ }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
})

test('taking an issue creates its worktree and the card switches to continuing', async () => {
  let created = false
  const host = mockHost({
    requests: {
      ...configuredRequests,
      'redmine.issues': () => ({
        ...SNAPSHOT,
        issues: [SNAPSHOT.issues[0], issue(14700, 1, created ? 'ws-14700' : null)]
      }),
      'redmine.details': ({ id }) => details(id, 1, created ? 'ws-14700' : null),
      'redmine.start': () => {
        created = true
        return { workspace: 'shop / 14700', prompt: '/task-start 14700', created: true }
      }
    }
  })
  view = await mount(panel, { host })
  await view.press({ label: '#14700 Задача 14700' })
  await view.press({ role: 'button', text: 'Взять в работу' })
  assert.ok(view.find({ text: /Создан worktree «shop \/ 14700», агент запущен/ }))
  assert.ok(view.find({ role: 'button', text: 'Продолжить' }))
  assert.equal(view.find({ role: 'button', text: 'Взять в работу' }), null)
  assert.deepEqual(view.errors, [])
})

test('Enter on a number outside the list opens that issue', async () => {
  view = await mount(panel, { host: mockHost({ requests: configuredRequests }) })
  await view.type({ label: 'Поиск' }, '#13871', { submit: true })
  assert.ok(view.find({ text: /Взять в работу/ }))
  assert.ok(view.find({ text: /Текст описания/ }))
  const fields = view.find({ type: 'KeyValue' })?.props.items as { label: string; value: unknown; tone?: string }[]
  assert.deepEqual(fields.find((f) => f.label === 'Исполнитель'), {
    label: 'Исполнитель',
    value: 'не назначен',
    tone: 'warning'
  })
  assert.deepEqual(view.errors, [])
})

test('changing the address keeps the stored key unless a new one is typed', async () => {
  const sent: { baseUrl: string; key?: string }[] = []
  view = await mount(panel, {
    host: mockHost({
      requests: {
        ...configuredRequests,
        'redmine.connect': (input) => {
          sent.push(input)
          return { user: 'Анна Смирнова', baseUrl: 'https://new.test' }
        }
      }
    })
  })
  await view.press({ label: 'Адрес Redmine и API-ключ' })
  assert.equal(view.find({ label: 'Адрес Redmine' })?.props.value, 'https://redmine.test')
  await view.type({ label: 'Адрес Redmine' }, 'https://new.test', { replace: true, submit: true })
  assert.deepEqual(sent, [{ baseUrl: 'https://new.test', key: '' }])
  assert.ok(view.find({ label: '#14605 Задача 14605' }))
  assert.deepEqual(view.errors, [])
})

test('groups follow Redmine status order and the order the person sets', async () => {
  view = await mount(panel, { host: mockHost({ requests: configuredRequests }) })
  const groups = () =>
    view!
      .findAll({ type: 'Collapsible' })
      .map((c) => String(c.props.title))
      .filter((t) => /· \d+$/.test(t))
  assert.deepEqual(groups(), ['В работе · 1', 'Новая · 1'])

  await view.press({ label: 'Порядок статусов' })
  assert.ok(view.find({ role: 'button', text: 'Как в Redmine' }))
  // Closed statuses never reach the list, so there is nothing to order.
  assert.equal(view.find({ text: 'Закрыта' }), null)
  await view.press(view.findAll({ role: 'button', text: '↓' })[0])
  assert.deepEqual(groups(), ['Новая · 1', 'В работе · 1'])
  assert.deepEqual(view.persisted.plugin.statusOrder, [1, 2])

  await view.press({ role: 'button', text: 'Как в Redmine' })
  assert.deepEqual(groups(), ['В работе · 1', 'Новая · 1'])
  await view.press({ role: 'button', text: 'Готово' })
  assert.equal(view.find({ text: 'Как в Redmine' }), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
})

test('changes the status from the card with a comment', async () => {
  const sent: { id: number; statusId: number; notes?: string }[] = []
  view = await mount(panel, {
    host: mockHost({
      requests: {
        ...configuredRequests,
        'redmine.setStatus': (input) => {
          sent.push(input)
          // Redmine bumps updated_on, which lets the card trust this over the older list entry.
          const next = details(input.id, input.statusId, 'ws-14605')
          return { ...next, issue: { ...next.issue, updatedAt: 1 } }
        }
      }
    })
  })
  await view.press({ label: '#14605 Задача 14605' })
  await view.press({ role: 'button', text: 'Сменить статус' })
  const options = view.find({ label: 'Новый статус' })?.props.options as { value: string; label: string }[]
  // The current status is not offered; a closing one says so.
  assert.deepEqual(options.map((o) => o.label), ['Новая', 'Закрыта (закрывает задачу)'])
  assert.equal(view.find({ role: 'button', text: 'Сохранить' })?.props.disabled, true)

  await view.select({ label: 'Новый статус' }, '5')
  await view.type({ label: 'Комментарий' }, 'Проверено')
  await view.press({ role: 'button', text: 'Сохранить' })
  assert.deepEqual(sent, [{ id: 14605, statusId: 5, notes: 'Проверено' }])
  assert.ok(view.find({ text: '#14605: статус «Закрыта»' }))
  assert.equal(view.find({ label: 'Новый статус' }), null)
  assert.ok(view.findAll({ type: 'Badge' }).some((b) => b.text === 'Закрыта'))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
})

test('a status the workflow refused keeps the form open and clears the posted comment', async () => {
  view = await mount(panel, {
    host: mockHost({
      requests: { ...configuredRequests, 'redmine.setStatus': ({ id }) => details(id, 2, 'ws-14605') }
    })
  })
  await view.press({ label: '#14605 Задача 14605' })
  await view.press({ role: 'button', text: 'Сменить статус' })
  await view.select({ label: 'Новый статус' }, '1')
  await view.type({ label: 'Комментарий' }, 'Возвращаю')
  await view.press({ role: 'button', text: 'Сохранить' })
  assert.ok(view.find({ text: /Redmine оставил статус «В работе», а не «Новая»/ }))
  assert.ok(view.find({ label: 'Новый статус' }))
  assert.equal(view.find({ label: 'Комментарий' })?.props.value, '')
  assert.deepEqual(view.errors, [])
})

test('shows what the worker throws', async () => {
  const host = mockHost({
    requests: {
      'redmine.state': () => ({ configured: true, hasKey: true, baseUrl: 'https://redmine.test' }),
      'redmine.issues': () => {
        throw new Error('Redmine отклонил API-ключ')
      }
    }
  })
  view = await mount(panel, { host })
  assert.ok(view.find({ text: /Redmine отклонил API-ключ/ }))
})

test('long text splits at blank lines and never inside a code fence', () => {
  const para = 'а'.repeat(30)
  const text = [para, '', '```', 'x', '', 'y', '```', '', para].join('\n')
  const parts = chunks(text, 20)
  assert.ok(parts.length > 1)
  assert.ok(parts.every((p) => (p.match(/```/g) ?? []).length % 2 === 0))
  assert.equal(parts.join('\n\n').replace(/\n+/g, '\n'), text.replace(/\n+/g, '\n'))
})
