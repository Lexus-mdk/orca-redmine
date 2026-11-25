// Runs src/worker.ts's activate(orca) over a mock host, with Redmine faked at the fetch level.
import { afterEach, assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

const BASE = 'https://redmine.test'
const REPO = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\projects\\shop'
type TestWorkspace = {
  id: string
  kind: 'worktree' | 'folder'
  name: string
  path: string
  branch: string | null
  hostId: string | null
  projectId: string | null
}

const WORKSPACES: TestWorkspace[] = [
  { id: `r::${REPO}`, kind: 'worktree', name: 'master', path: REPO, branch: 'refs/heads/master', hostId: 'local', projectId: 'p-shop' },
  {
    id: `r::${REPO}\\.claude\\worktrees\\14605`,
    kind: 'worktree',
    name: '14605',
    path: `${REPO}\\.claude\\worktrees\\14605`,
    branch: 'refs/heads/14605',
    hostId: 'local',
    projectId: 'p-shop'
  },
  // Same number in another repo must not count as the issue's workspace.
  { id: 'o::H:/other/14700', kind: 'worktree', name: '14700', path: 'H:/other/14700', branch: null, hostId: 'local', projectId: 'p-other' }
]

const PROJECTS = {
  projects: [
    { id: 'p-shop', name: 'shop', kind: 'git', hostId: 'local', path: REPO },
    { id: 'p-other', name: 'other', kind: 'git', hostId: 'local', path: 'H:/other' },
    { id: 'p-notes', name: 'notes', kind: 'folder', hostId: 'local', path: 'H:/notes' }
  ],
  truncated: false
}

/** What Orca lists now; workspace.create adds to it, as the real one does. */
let workspaces: TestWorkspace[] = [...WORKSPACES]

const STATUS_NAMES: Record<number, string> = { 1: 'Новая', 2: 'В работе', 3: 'Отклонена', 5: 'Закрыта' }
/** Statuses set through PUT; Redmine reports them from then on. */
let statusOf = new Map<number, number>()
let puts: { url: string; body: unknown; type: string | null }[] = []

const apiIssue = (id: number, statusId = 2) => ({
  id,
  subject: `Задача ${id}`,
  description: 'Описание',
  project: { name: 'Демо-проект' },
  tracker: { name: 'Ошибка' },
  status: { id: statusOf.get(id) ?? statusId, name: STATUS_NAMES[statusOf.get(id) ?? statusId] },
  priority: { name: 'Нормальный' },
  author: { name: 'Автор' },
  done_ratio: 0,
  updated_on: '2026-11-13T10:00:00Z'
})

// 16001 and 16003 are children of 14605, 16002 is a grandchild under 16001.
const SUBTREE = [
  { ...apiIssue(16001), parent: { id: 14605 }, assigned_to: { name: 'Иванов' } },
  { ...apiIssue(16002), parent: { id: 16001 }, closed_on: '2026-11-12T10:00:00Z' },
  { ...apiIssue(16003), parent: { id: 14605 } }
]

const withJournals = (id: number) => ({
  ...apiIssue(id),
  assigned_to: { name: 'Смирнова' },
  ...(id === 14605 ? { parent: { id: 14462 }, children: [{ id: 16001 }, { id: 16003 }] } : {}),
  ...(id === 14700 ? { parent: { id: 900 } } : {}),
  // 14700 plays a Redmine older than 5.0, which does not list allowed statuses.
  ...(id === 14700
    ? {}
    : {
        allowed_statuses: [
          { id: 1, name: 'Новая', is_closed: false },
          { id: 2, name: 'В работе', is_closed: false },
          { id: 5, name: 'Закрыта', is_closed: true }
        ]
      }),
  description: 'h2. Проблема\r\n\r\nСм. #15363 и @segment_name@',
  attachments: [{ filename: 'scan.png', content_url: `${BASE}/attachments/download/1/scan.png` }],
  journals: [
    { id: 1, user: { name: 'Петров' }, notes: 'Первый: *важно*', created_on: '2026-11-10T10:00:00Z' },
    // A status change without notes is not a comment.
    { id: 2, user: { name: 'Петров' }, notes: '', created_on: '2026-11-11T10:00:00Z' },
    {
      id: 3,
      user: { name: 'Смирнова' },
      notes: 'Скрин: !scan.png!',
      private_notes: true,
      created_on: '2026-11-12T10:00:00Z'
    }
  ]
})

let assigned = [apiIssue(14605), apiIssue(14700, 1)]
let calls: { url: string; key: string | null }[] = []
const realFetch = globalThis.fetch

function fakeRedmine(acceptedKey = 'good'): void {
  calls = []
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const key = new Headers(init?.headers).get('X-Redmine-API-Key')
    calls.push({ url, key })
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (key !== acceptedKey) return json({}, 401)
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { issue: { status_id: number } }
      puts.push({ url, body, type: new Headers(init.headers).get('Content-Type') })
      const id = Number(url.match(/\/issues\/(\d+)\.json$/)?.[1])
      const wanted = body.issue.status_id
      if (wanted === 99) return json({ errors: ['Затраченное время не может быть пустым'] }, 422)
      // Like Redmine, a status the workflow forbids is dropped without an error.
      if (wanted !== 3) statusOf.set(id, wanted)
      return new Response(null, { status: 204 })
    }
    if (url.startsWith(`${BASE}/users/current.json`)) {
      return json({ user: { firstname: 'Анна', lastname: 'Смирнова' } })
    }
    if (url.startsWith(`${BASE}/issues.json?parent_id=~14605&`)) return json({ issues: SUBTREE })
    if (url.startsWith(`${BASE}/issues.json`)) {
      const open = assigned.map((i) => apiIssue(i.id, i.status.id)).filter((i) => i.status.id !== 5)
      return json({ issues: open })
    }
    const one = url.match(/\/issues\/(\d+)\.json\?include=journals,attachments,children,allowed_statuses$/)
    if (one) return json({ issue: withJournals(Number(one[1])) })
    if (url === `${BASE}/issues/14462.json`) return json({ issue: apiIssue(14462, 1) })
    if (url === `${BASE}/issues/900.json`) return json({}, 403)
    const plain = url.match(/^https:\/\/redmine\.test\/issues\/(\d+)\.json$/)
    if (plain) return json({ issue: apiIssue(Number(plain[1])) })
    if (url === `${BASE}/issue_statuses.json`) {
      return json({
        issue_statuses: [
          { id: 1, name: 'Новая', is_closed: false },
          { id: 2, name: 'В работе', is_closed: false },
          { id: 5, name: 'Закрыта', is_closed: true }
        ]
      })
    }
    return json({}, 404)
  }) as typeof fetch
}

// A project folder and agent commands as prompts, as a team with its own skills sets them.
const SKILL_SETTINGS = {
  projectFolder: 'shop',
  startPrompt: '/task-start {id}',
  continuePrompt: '/task-continue {id}',
  pollMinutes: 0
}

function host(
  secrets: Record<string, string> = { apiKey: 'good' },
  options: { settings?: Record<string, string | number | boolean>; storage?: Record<string, string> } = {}
) {
  return mockHost({
    secrets,
    storage: options.storage ?? { baseUrl: BASE },
    settings: options.settings ?? SKILL_SETTINGS,
    results: {
      'workspace.list': () => ({ workspaces, truncated: false }),
      'project.list': PROJECTS,
      'workspace.readContext': { branch: 'master', displayName: 'master', terminals: [] },
      'workspace.create': (params: { projectId: string; name: string }) => {
        const project = PROJECTS.projects.find((p) => p.id === params.projectId)!
        const path = `${project.path}\\.orca\\worktrees\\${params.name}`
        workspaces = [
          ...workspaces,
          { id: `r::${path}`, kind: 'worktree', name: params.name, path, branch: `refs/heads/${params.name}`, hostId: 'local', projectId: project.id }
        ]
        return { workspaceId: `r::${path}`, terminalId: 't2' }
      },
      'agent.launch': { terminalId: 't1' },
      'workspace.open': { opened: true },
      'statusBar.update': { ok: true },
      'notifications.show': { delivered: true }
    }
  })
}

afterEach(() => {
  globalThis.fetch = realFetch
  statusOf = new Map()
  puts = []
  assigned = [apiIssue(14605), apiIssue(14700, 1)]
  workspaces = [...WORKSPACES]
})

test('lists assigned issues and links only the shop worktree named by the number', async () => {
  fakeRedmine()
  const h = host()
  const worker = await mountWorker(main, { host: h })
  const snapshot = await worker.request('redmine.issues', { force: true })
  assert.equal(snapshot.user, 'Анна Смирнова')
  assert.deepEqual(
    snapshot.issues.map((i) => [i.id, i.workspaceId]),
    [
      [14605, `r::${REPO}\\.claude\\worktrees\\14605`],
      [14700, null]
    ]
  )
  assert.equal(snapshot.issues[0].url, `${BASE}/issues/14605`)
  assert.ok(calls.some((c) => c.url.includes('assigned_to_id=me') && c.url.includes('status_id=open')))
  const bar = h.callsOf('statusBar.update').at(-1) as { text: string } | undefined
  assert.equal(bar?.text, 'Redmine: 2')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('details convert Textile and list comments newest first', async () => {
  fakeRedmine()
  const worker = await mountWorker(main, { host: host() })
  const details = await worker.request('redmine.details', { id: 14605 })
  assert.equal(details.issue.workspaceId, `r::${REPO}\\.claude\\worktrees\\14605`)
  assert.equal(details.issue.assignee, 'Смирнова')
  assert.equal(
    details.description,
    `### Проблема\n\nСм. [#15363](${BASE}/issues/15363) и \`segment_name\``
  )
  assert.equal(details.commentsTotal, 2)
  assert.equal(details.attachments, 1)
  assert.deepEqual(
    details.comments.map((c) => [c.id, c.author, c.private, c.text]),
    [
      [3, 'Смирнова', true, `Скрин: [🖼 scan.png](${BASE}/attachments/download/1/scan.png)`],
      [1, 'Петров', false, 'Первый: **важно**']
    ]
  )
  await worker.deactivate()
})

test('details carry the parent and the whole subtree, depth first', async () => {
  fakeRedmine()
  const worker = await mountWorker(main, { host: host() })
  const details = await worker.request('redmine.details', { id: 14605 })
  assert.deepEqual(details.parent, { id: 14462, subject: 'Задача 14462', status: 'Новая' })
  assert.deepEqual(
    details.subtasks.map((t) => [t.id, t.depth, t.closed, t.assignee]),
    [
      [16001, 1, false, 'Иванов'],
      [16002, 2, true, ''],
      [16003, 1, false, '']
    ]
  )

  // A parent the key cannot read keeps its number; no children means no extra request.
  calls = []
  const hidden = await worker.request('redmine.details', { id: 14700 })
  assert.deepEqual(hidden.parent, { id: 900, subject: '', status: '' })
  assert.deepEqual(hidden.subtasks, [])
  assert.ok(!calls.some((c) => c.url.includes('parent_id')))
  await worker.deactivate()
})

test('a Markdown Redmine keeps its text and only gets issue links', async () => {
  fakeRedmine()
  const h = host(undefined, { settings: { ...SKILL_SETTINGS, textFormat: 'markdown' } })
  const worker = await mountWorker(main, { host: h })
  const details = await worker.request('redmine.details', { id: 14605 })
  assert.equal(
    details.description,
    `h2. Проблема\n\nСм. [#15363](${BASE}/issues/15363) и @segment_name@`
  )
  await worker.deactivate()
})

test('notifies only about issues that appeared since the last fetch', async () => {
  fakeRedmine()
  const h = host()
  const worker = await mountWorker(main, { host: h })
  await worker.request('redmine.issues', { force: true })
  const before = h.callsOf('notifications.show').length
  assigned = [...assigned, apiIssue(14800, 1)]
  await worker.request('redmine.issues', { force: true })
  const shown = h.callsOf('notifications.show').slice(before) as { title: string }[]
  assert.equal(shown.length, 1)
  assert.equal(shown[0].title, 'Новая задача #14800')
  await worker.deactivate()
})

test('overlapping refreshes notify about a new issue once', async () => {
  fakeRedmine()
  const h = host()
  const worker = await mountWorker(main, { host: h })
  await worker.request('redmine.issues', { force: true })
  const before = h.callsOf('notifications.show').length
  assigned = [...assigned, apiIssue(14800, 1)]
  // Startup, a background poll and an opening panel can all ask at the same moment.
  await Promise.all([
    worker.request('redmine.issues', { force: true }),
    worker.request('redmine.issues', { force: true }),
    worker.request('redmine.issues', { force: true })
  ])
  assert.equal(h.callsOf('notifications.show').length - before, 1)
  await worker.deactivate()
})

test('stays quiet on the first fetch and with notifications off', async () => {
  fakeRedmine()
  const h = host(undefined, { settings: { ...SKILL_SETTINGS, notifyNew: false } })
  const worker = await mountWorker(main, { host: h })
  await worker.request('redmine.issues', { force: true })
  assigned = [...assigned, apiIssue(14800, 1)]
  await worker.request('redmine.issues', { force: true })
  assert.equal(h.callsOf('notifications.show').length, 0)
  // Ids are still tracked, so turning notifications on later brings no burst of old issues.
  assert.deepEqual(h.data().storage?.knownIds, [14605, 14700, 14800])
  await worker.deactivate()
})

test('a new connection starts the comparison over', async () => {
  fakeRedmine()
  const h = host()
  const worker = await mountWorker(main, { host: h })
  await worker.request('redmine.issues', { force: true })
  await worker.request('redmine.connect', { baseUrl: BASE, key: 'good' })
  assigned = [...assigned, apiIssue(14800, 1)]
  await worker.request('redmine.issues', { force: true })
  assert.equal(h.callsOf('notifications.show').length, 0)
  await worker.deactivate()
})

test('continues in the issue worktree, creates one with the agent for a new issue', async () => {
  fakeRedmine()
  const h = host(undefined, {
    settings: { ...SKILL_SETTINGS, agent: 'codex', baseBranch: 'master', worktreeName: 'task-{id}' }
  })
  const worker = await mountWorker(main, { host: h })

  const own = await worker.request('redmine.start', { id: 14605 })
  assert.deepEqual(own, { workspace: '14605', prompt: '/task-continue 14605', created: false })
  const launches = h.callsOf('agent.launch') as { workspaceId: string; agent: string }[]
  assert.deepEqual(
    launches.map((l) => [l.workspaceId, l.agent]),
    [[`r::${REPO}\\.claude\\worktrees\\14605`, 'codex']]
  )

  const fresh = await worker.request('redmine.start', { id: 14999 })
  assert.deepEqual(fresh, { workspace: 'shop / task-14999', prompt: '/task-start 14999', created: true })
  assert.deepEqual(h.callsOf('workspace.create'), [
    {
      projectId: 'p-shop',
      hostId: 'local',
      name: 'task-14999',
      baseBranch: 'master',
      agent: 'codex',
      prompt: '/task-start 14999',
      open: true
    }
  ])
  // The agent starts with the worktree; no second launch.
  assert.equal(h.callsOf('agent.launch').length, 1)

  // From now on the issue has its workspace, and the button continues there.
  const snapshot = await worker.request('redmine.issues', { force: true })
  assert.equal(snapshot.issues.length, 2)
  const again = await worker.request('redmine.start', { id: 14999 })
  assert.deepEqual(again, { workspace: 'task-14999', prompt: '/task-continue 14999', created: false })
  assert.equal(h.callsOf('workspace.create').length, 1)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('with the default settings creates the worktree in the focused project and fills the prompt', async () => {
  fakeRedmine()
  const h = host(undefined, { settings: { pollMinutes: 0 } })
  const worker = await mountWorker(main, { host: h })

  // No project folder: no issue is tied to a workspace, even one named by its number.
  const snapshot = await worker.request('redmine.issues', { force: true })
  assert.deepEqual(snapshot.issues.map((i) => i.workspaceId), [null, null])

  const started = await worker.request('redmine.start', { id: 14999 })
  const prompt = `Возьми в работу задачу Redmine #14999 «Задача 14999»: ${BASE}/issues/14999. Разберись в ней и предложи план работ.`
  assert.deepEqual(started, { workspace: 'shop / 14999', prompt, created: true })
  const create = h.callsOf('workspace.create')[0] as { projectId: string; name: string; agent: string }
  assert.deepEqual([create.projectId, create.name, create.agent], ['p-shop', '14999', 'claude'])

  // The created worktree is remembered, so it counts even without a project folder.
  const details = await worker.request('redmine.details', { id: 14999 })
  assert.equal(details.issue.workspaceId, `r::${REPO}\\.orca\\worktrees\\14999`)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('explains why a worktree cannot be created', async () => {
  fakeRedmine()
  const noFocus = host(undefined, { settings: { pollMinutes: 0 } })
  noFocus.respond('workspace.readContext', null)
  let worker = await mountWorker(main, { host: noFocus })
  await assert.rejects(worker.request('redmine.start', { id: 14999 }), /Откройте в Orca workspace/)
  await worker.deactivate()

  worker = await mountWorker(main, { host: host(undefined, { settings: { ...SKILL_SETTINGS, projectFolder: 'notes' } }) })
  await assert.rejects(worker.request('redmine.start', { id: 14999 }), /папка без Git/)
  await worker.deactivate()

  worker = await mountWorker(main, { host: host(undefined, { settings: { ...SKILL_SETTINGS, projectFolder: 'nope' } }) })
  await assert.rejects(worker.request('redmine.start', { id: 14999 }), /нет проекта «nope»/)
  await worker.deactivate()

  const asking = host()
  asking.respond('workspace.create', () => {
    throw new Error("this project's setup script needs a decision; pass setup: 'skip' or create it in Orca")
  })
  worker = await mountWorker(main, { host: asking })
  await assert.rejects(worker.request('redmine.start', { id: 14999 }), /Пропускать setup-скрипт/)
  await worker.deactivate()

  const skipping = host(undefined, { settings: { ...SKILL_SETTINGS, skipSetup: true } })
  worker = await mountWorker(main, { host: skipping })
  await worker.request('redmine.start', { id: 14999 })
  assert.equal((skipping.callsOf('workspace.create')[0] as { setup?: string }).setup, 'skip')
  await worker.deactivate()
})

test('connects with an address and a key, checking both before storing', async () => {
  fakeRedmine()
  const h = host({}, { storage: {} })
  const worker = await mountWorker(main, { host: h })
  assert.deepEqual(await worker.request('redmine.state'), {
    configured: false,
    hasKey: false,
    baseUrl: ''
  })
  await assert.rejects(worker.request('redmine.connect', { baseUrl: 'redmine.test' }), /API-ключ/)
  await assert.rejects(
    worker.request('redmine.connect', { baseUrl: 'ftp://redmine.test', key: 'good' }),
    /https/
  )

  // Scheme added, trailing slash and a browser query dropped.
  assert.deepEqual(
    await worker.request('redmine.connect', { baseUrl: ' redmine.test/?tab=1 ', key: ' good ' }),
    { user: 'Анна Смирнова', baseUrl: BASE }
  )
  assert.equal(h.data().secrets?.apiKey, 'good')
  assert.equal(h.data().storage?.baseUrl, BASE)
  assert.deepEqual(await worker.request('redmine.state'), {
    configured: true,
    hasKey: true,
    baseUrl: BASE
  })
  await worker.deactivate()
})

test('keeps the old connection when Redmine rejects a new key or address', async () => {
  fakeRedmine()
  const h = host()
  const worker = await mountWorker(main, { host: h })
  await assert.rejects(worker.request('redmine.connect', { baseUrl: BASE, key: 'bad' }), /отклонил/)
  assert.equal(h.data().secrets?.apiKey, 'good')

  await assert.rejects(
    worker.request('redmine.connect', { baseUrl: 'https://other.test' }),
    /нет Redmine API/
  )
  assert.equal(h.data().storage?.baseUrl, BASE)

  // An empty key field reuses the stored key.
  assert.deepEqual(await worker.request('redmine.connect', { baseUrl: `${BASE}/`, key: '' }), {
    user: 'Анна Смирнова',
    baseUrl: BASE
  })
  assert.equal(h.data().secrets?.apiKey, 'good')
  await worker.deactivate()
})

test('lists statuses in Redmine order, closed ones marked', async () => {
  fakeRedmine()
  const worker = await mountWorker(main, { host: host() })
  const { statuses } = await worker.request('redmine.statuses')
  assert.deepEqual(
    statuses.map((s) => [s.id, s.closed]),
    [
      [1, false],
      [2, false],
      [5, true]
    ]
  )
  await worker.deactivate()
})

test('changes the status with a comment, and a closed issue leaves the list', async () => {
  fakeRedmine()
  const h = host()
  const worker = await mountWorker(main, { host: h })
  await worker.request('redmine.issues', { force: true })
  const before = await worker.request('redmine.details', { id: 14605 })
  assert.deepEqual(
    before.allowedStatuses?.map((s) => [s.id, s.closed]),
    [
      [1, false],
      [2, false],
      [5, true]
    ]
  )
  assert.equal((await worker.request('redmine.details', { id: 14700 })).allowedStatuses, null)

  const after = await worker.request('redmine.setStatus', { id: 14605, statusId: 5, notes: ' Готово ' })
  assert.equal(after.issue.status, 'Закрыта')
  assert.deepEqual(puts, [
    {
      url: `${BASE}/issues/14605.json`,
      body: { issue: { status_id: 5, notes: 'Готово' } },
      type: 'application/json'
    }
  ])
  // The refresh begun by the write is the one shared here, so it already knows.
  const snapshot = await worker.request('redmine.issues', { force: true })
  assert.deepEqual(snapshot.issues.map((i) => i.id), [14700])
  assert.equal((h.callsOf('statusBar.update').at(-1) as { text: string }).text, 'Redmine: 1')
  assert.equal(h.callsOf('notifications.show').length, 0)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a forbidden status comes back unchanged, a validation error is spelled out', async () => {
  fakeRedmine()
  const worker = await mountWorker(main, { host: host() })
  const kept = await worker.request('redmine.setStatus', { id: 14605, statusId: 3 })
  assert.equal(kept.issue.statusId, 2)
  // No comment means no notes key, so Redmine adds no empty journal.
  assert.deepEqual(puts[0].body, { issue: { status_id: 3 } })
  await assert.rejects(
    worker.request('redmine.setStatus', { id: 14605, statusId: 99 }),
    /Redmine не принял изменение: Затраченное время не может быть пустым/
  )
  await worker.deactivate()
})

test('reports a missing key instead of calling Redmine', async () => {
  fakeRedmine()
  const worker = await mountWorker(main, { host: host({}) })
  assert.deepEqual(await worker.request('redmine.state'), {
    configured: false,
    hasKey: false,
    baseUrl: BASE
  })
  await assert.rejects(worker.request('redmine.issues', {}), /не задан/)
  assert.equal(calls.length, 0)
  await worker.deactivate()
})
