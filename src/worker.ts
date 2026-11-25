// Talks to Redmine for the panel and keeps the status bar item current. Panels have no network,
// so every Redmine call lives here; the API key never leaves the worker and the secrets store.
import type { OrcaWorkerApi } from 'orca/worker'
import type {
  RedmineComment,
  RedmineDetails,
  RedmineIssue,
  RedmineSnapshot,
  RedmineStatus,
  RedmineSubtask
} from './protocol'
import { markdownWithIssueLinks, textileToMarkdown, type MarkupContext } from './textile'

const KEY_SECRET = 'apiKey'
// The address is entered together with the key, so it lives next to it and not in Settings.
const BASE_URL = 'baseUrl'
const SNAPSHOT = 'snapshot'
const KNOWN_IDS = 'knownIds'
const USER = 'user'
/** Issue id → id of the worktree this plugin created for it; ties them without a project folder. */
const CREATED = 'createdWorkspaces'
const STATUS_ITEM = 'redmine'
// The panel reopens often; a short cache keeps that from hitting Redmine every time.
const CACHE_MS = 60_000
const REQUEST_TIMEOUT_MS = 15_000
// The panel splits long text into blocks; these only stop a pasted log from flooding it.
const DESCRIPTION_LIMIT = 40_000
const COMMENT_LIMIT = 8_000
const COMMENTS_SHOWN = 30

// Keep in step with the defaults in orca-plugin.json: Settings shows those, the worker uses these.
const DEFAULTS = {
  projectFolder: '',
  agent: 'claude',
  startPrompt:
    'Возьми в работу задачу Redmine #{id} «{subject}»: {url}. Разберись в ней и предложи план работ.',
  continuePrompt: 'Продолжи работу над задачей Redmine #{id} «{subject}»: {url}.',
  worktreeName: '{id}',
  baseBranch: '',
  skipSetup: false,
  pollMinutes: 5,
  notifyNew: true,
  textFormat: 'textile' as 'textile' | 'markdown'
}
type Settings = typeof DEFAULTS & { baseUrl: string }

type ApiIssue = {
  id: number
  subject: string
  description?: string | null
  project?: { name: string }
  tracker?: { name: string }
  status?: { id: number; name: string }
  priority?: { name: string }
  author?: { name: string }
  assigned_to?: { name: string }
  parent?: { id: number }
  children?: { id: number }[]
  done_ratio?: number
  updated_on: string
  closed_on?: string | null
  /** Redmine 5.0+ with include=allowed_statuses: what the key's owner may switch the issue to. */
  allowed_statuses?: { id: number; name: string; is_closed?: boolean }[]
  journals?: {
    id: number
    user?: { name: string }
    notes?: string | null
    private_notes?: boolean
    created_on: string
  }[]
  attachments?: { filename: string; content_url: string }[]
}

type Workspace = {
  id: string
  kind: 'worktree' | 'folder'
  name: string
  path: string
  branch: string | null
  projectId?: string | null
}

type Project = {
  id: string
  name: string
  kind: 'git' | 'folder'
  hostId: string | null
  path: string
}

/** A message the panel can show as is; `action_failed` keeps Orca from rewriting it. */
function fail(message: string, status?: number): never {
  throw Object.assign(new Error(message), { code: 'action_failed', status })
}

/** Accepts what people paste: no scheme, a trailing slash, a query left over from the browser. */
function normalizeUrl(input: string): string {
  let text = input.trim()
  if (!text) fail('Укажите адрес Redmine')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`
  let url: URL
  try {
    url = new URL(text)
  } catch {
    fail(`Не похоже на адрес: ${input.trim()}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    fail('Адрес Redmine должен начинаться с https:// или http://')
  }
  url.search = ''
  url.hash = ''
  // Redmine may live under a sub-path (example.com/redmine), so only the trailing slash goes.
  return url.toString().replace(/\/+$/, '')
}

async function storedBaseUrl(orca: OrcaWorkerApi): Promise<string> {
  const value = await orca.storage.get(BASE_URL)
  return typeof value === 'string' ? value : ''
}

async function connected(orca: OrcaWorkerApi): Promise<boolean> {
  return Boolean((await orca.secrets.get(KEY_SECRET)) && (await storedBaseUrl(orca)))
}

async function readSettings(orca: OrcaWorkerApi): Promise<Settings> {
  const stored = (await orca.settings.get()) as Partial<typeof DEFAULTS>
  const merged = { ...DEFAULTS, ...stored, baseUrl: await storedBaseUrl(orca) }
  merged.projectFolder = String(merged.projectFolder ?? '').trim()
  merged.worktreeName = String(merged.worktreeName ?? '').trim() || DEFAULTS.worktreeName
  merged.baseBranch = String(merged.baseBranch ?? '').trim()
  return merged
}

/** Names the address to connect to instead; usually http:// moved to https:// or a new host. */
function redirectMessage(baseUrl: string, path: string, response: Response): string {
  const location = response.headers.get('location')
  let target = ''
  try {
    if (location) target = new URL(location, `${baseUrl}${path}`).toString()
  } catch {
    // An unparsable Location still gets the generic message.
  }
  if (!target) return `${baseUrl} перенаправляет запрос. Укажите в подключении адрес, по которому Redmine открывается.`
  // The redirect keeps the API path, so cutting it off leaves the base address to suggest.
  const pathOnly = path.split('?')[0]
  const bare = target.split(/[?#]/)[0]
  const base = bare.endsWith(pathOnly) ? bare.slice(0, -pathOnly.length) : ''
  return base
    ? `${baseUrl} перенаправляет на ${base}. Подключитесь по этому адресу (шестерёнка в шапке панели).`
    : `${baseUrl} перенаправляет на ${target}. Укажите в подключении адрес, по которому Redmine открывается.`
}

async function redmine<T>(
  orca: OrcaWorkerApi,
  path: string,
  options: {
    key?: string
    baseUrl?: string
    signal?: AbortSignal
    method?: 'GET' | 'PUT'
    body?: unknown
  } = {}
): Promise<T> {
  const key = options.key ?? (await orca.secrets.get(KEY_SECRET))
  if (!key) fail('API-ключ Redmine не задан')
  const baseUrl = options.baseUrl ?? (await storedBaseUrl(orca))
  if (!baseUrl) fail('Адрес Redmine не задан')
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let response: Response
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        'X-Redmine-API-Key': key,
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      // fetch drops only Authorization on a cross-origin redirect, so following one would hand
      // the API key to whatever host Redmine (or a proxy in front of it) points at.
      redirect: 'manual',
      signal
    })
  } catch (error) {
    if (timeout.aborted) fail(`Redmine не ответил за ${REQUEST_TIMEOUT_MS / 1000} с (${baseUrl})`)
    fail(`Нет связи с ${baseUrl}: ${(error as Error).message}`)
  }
  if (response.status >= 300 && response.status < 400) fail(redirectMessage(baseUrl, path, response))
  if (response.status === 401) fail('Redmine отклонил API-ключ')
  if (response.status === 403) fail('Нет прав на этот запрос в Redmine')
  if (response.status === 404) fail('Не найдено в Redmine', 404)
  if (response.status === 422) {
    // Validation: a required field the new status demands, a closed parent, and the like.
    const errors = await response
      .json()
      .then((body: { errors?: string[] }) => body.errors ?? [])
      .catch(() => [] as string[])
    fail(`Redmine не принял изменение${errors.length ? `: ${errors.join('; ')}` : ''}`, 422)
  }
  if (!response.ok) fail(`Redmine ответил ${response.status}`)
  // Writes answer 204 with no body.
  if (response.status === 204) return undefined as T
  try {
    return (await response.json()) as T
  } catch {
    // A login page or a proxy error answers 200 with HTML.
    fail(`${baseUrl} ответил не как Redmine API: проверьте адрес`)
  }
}

const issueNumber = (id: number) => new RegExp(`(^|[^0-9])${id}([^0-9]|$)`)
const segments = (path: string) => path.split(/[\\/]+/).filter(Boolean)
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const shortBranch = (branch: string | null) => (branch ?? '').replace(/^refs\/heads\//, '')

/** Everything that ties issues to workspaces, read once per request. */
type WorkspaceIndex = { all: Workspace[]; folder: string; created: Record<string, string> }

async function readCreated(orca: OrcaWorkerApi): Promise<Record<string, string>> {
  const value = await orca.storage.get(CREATED)
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, string>)
    : {}
}

async function workspaceIndex(orca: OrcaWorkerApi, folder: string): Promise<WorkspaceIndex> {
  const [{ workspaces }, created] = await Promise.all([
    orca.host.call('workspace.list'),
    readCreated(orca)
  ])
  return { all: workspaces as Workspace[], folder, created }
}

/**
 * The worktree this plugin created for the issue, else a worktree of the project folder whose
 * folder or branch carries the number, e.g. worktrees/14605.
 */
function workspaceFor(id: number, index: WorkspaceIndex): Workspace | null {
  const createdId = index.created[String(id)]
  const created = createdId ? index.all.find((w) => w.id === createdId) : undefined
  if (created) return created
  // Without a project folder only created worktrees count: a bare number matches too much.
  const { folder } = index
  if (!folder) return null
  const pattern = issueNumber(id)
  return (
    index.all.find((w) => {
      const parts = segments(w.path)
      const last = parts[parts.length - 1] ?? ''
      if (!parts.some((part) => sameName(part, folder)) || sameName(last, folder)) return false
      return pattern.test(last) || pattern.test(w.branch ?? '')
    }) ?? null
  )
}

/** The workspace open in Orca now; readContext's id may differ from workspace.list's, so names back it up. */
async function focusedWorkspace(orca: OrcaWorkerApi, all: Workspace[]): Promise<Workspace | null> {
  const context = await orca.host.call('workspace.readContext')
  if (!context) return null
  const byId = context.workspaceId ? all.find((w) => w.id === context.workspaceId) : undefined
  if (byId) return byId
  const named = all.filter((w) => w.name === context.displayName)
  return named.find((w) => shortBranch(w.branch) === shortBranch(context.branch)) ?? named[0] ?? null
}

/** Where new worktrees go: the project named in Settings, else the focused workspace's project. */
async function targetProject(orca: OrcaWorkerApi, index: WorkspaceIndex): Promise<Project> {
  const { projects } = await orca.host.call('project.list')
  const { folder } = index
  let project: Project | undefined
  if (folder) {
    project = (projects as Project[]).find(
      (p) => sameName(p.name, folder) || sameName(segments(p.path).at(-1) ?? '', folder)
    )
    if (!project) fail(`В Orca нет проекта «${folder}». Проверьте папку проекта в настройках плагина.`)
  } else {
    const focused = await focusedWorkspace(orca, index.all)
    project = focused?.projectId
      ? (projects as Project[]).find((p) => p.id === focused.projectId)
      : undefined
    if (!project) {
      fail('Откройте в Orca workspace проекта или укажите папку проекта в настройках плагина.')
    }
  }
  if (project.kind !== 'git') fail(`«${project.name}» — папка без Git: в ней не создать worktree.`)
  return project
}

async function rememberCreated(orca: OrcaWorkerApi, id: number, workspaceId: string, all: Workspace[]) {
  const created = await readCreated(orca)
  const alive = new Set(all.map((w) => w.id))
  // Worktrees removed since are dropped, so the map does not grow forever.
  const kept = Object.fromEntries(Object.entries(created).filter(([, w]) => alive.has(w)))
  await orca.storage.set(CREATED, { ...kept, [String(id)]: workspaceId })
}

/** Orca's own wording is for developers; this one says what to change. */
function explainCreateError(error: Error): never {
  if (/setup script needs a decision/.test(error.message)) {
    fail(
      'У проекта есть setup-скрипт, а Orca настроена спрашивать перед его запуском. Выберите в настройках проекта в Orca «запускать» или «не запускать», либо включите «Пропускать setup-скрипт» в настройках плагина.'
    )
  }
  if (/already exists/i.test(error.message)) {
    fail(`Такой worktree или ветка уже есть: ${error.message}. Поменяйте «Имя worktree» в настройках плагина.`)
  }
  throw error
}

function toIssue(raw: ApiIssue, baseUrl: string, workspace: Workspace | null): RedmineIssue {
  return {
    id: raw.id,
    subject: raw.subject,
    project: raw.project?.name ?? '',
    tracker: raw.tracker?.name ?? '',
    status: raw.status?.name ?? '',
    statusId: raw.status?.id ?? 0,
    priority: raw.priority?.name ?? '',
    author: raw.author?.name ?? '',
    assignee: raw.assigned_to?.name ?? '',
    doneRatio: raw.done_ratio ?? 0,
    updatedAt: Date.parse(raw.updated_on),
    url: `${baseUrl}/issues/${raw.id}`,
    workspaceId: workspace?.id ?? null
  }
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n\n…` : text
}

function toMarkdown(
  text: string | null | undefined,
  limit: number,
  settings: Settings,
  ctx: MarkupContext
): string {
  const source = clip((text ?? '').trim(), limit)
  if (!source) return ''
  return settings.textFormat === 'markdown'
    ? markdownWithIssueLinks(source, ctx)
    : textileToMarkdown(source, ctx)
}

const toSubtask = (issue: ApiIssue, depth: number): RedmineSubtask => ({
  id: issue.id,
  subject: issue.subject,
  tracker: issue.tracker?.name ?? '',
  status: issue.status?.name ?? '',
  closed: Boolean(issue.closed_on),
  assignee: issue.assigned_to?.name ?? '',
  doneRatio: issue.done_ratio ?? 0,
  depth
})

/** Flattens Redmine's descendant list into depth-first order under `rootId`. */
function subtaskTree(rootId: number, issues: ApiIssue[]): RedmineSubtask[] {
  const byParent = new Map<number, ApiIssue[]>()
  for (const issue of issues) {
    const parentId = issue.parent?.id ?? rootId
    byParent.set(parentId, [...(byParent.get(parentId) ?? []), issue])
  }
  const result: RedmineSubtask[] = []
  const seen = new Set<number>()
  const walk = (parentId: number, depth: number) => {
    for (const issue of byParent.get(parentId) ?? []) {
      if (seen.has(issue.id)) continue
      seen.add(issue.id)
      result.push(toSubtask(issue, depth))
      walk(issue.id, depth + 1)
    }
  }
  walk(rootId, 1)
  // A page limit can cut a middle level away; show the orphans rather than drop them.
  for (const issue of issues) {
    if (!seen.has(issue.id)) result.push(toSubtask(issue, 1))
  }
  return result
}

async function relatives(
  orca: OrcaWorkerApi,
  raw: ApiIssue,
  signal?: AbortSignal
): Promise<Pick<RedmineDetails, 'parent' | 'subtasks'>> {
  const parentId = raw.parent?.id
  const [parent, subtasks] = await Promise.all([
    parentId
      ? redmine<{ issue: ApiIssue }>(orca, `/issues/${parentId}.json`, { signal }).then(
          ({ issue }) => ({ id: parentId, subject: issue.subject, status: issue.status?.name ?? '' }),
          // A parent in a project the key cannot see still deserves its number on the card.
          () => ({ id: parentId, subject: '', status: '' })
        )
      : null,
    raw.children?.length
      ? redmine<{ issues: ApiIssue[] }>(
          orca,
          `/issues.json?parent_id=~${raw.id}&status_id=*&sort=id&limit=100`,
          { signal }
        ).then(({ issues }) => subtaskTree(raw.id, issues))
      : []
  ])
  return { parent, subtasks }
}

const toStatus = (s: { id: number; name: string; is_closed?: boolean }): RedmineStatus => ({
  id: s.id,
  name: s.name,
  closed: Boolean(s.is_closed)
})

function toDetails(
  raw: ApiIssue,
  settings: Settings,
  workspace: Workspace | null,
  family: Pick<RedmineDetails, 'parent' | 'subtasks'>
): RedmineDetails {
  const ctx: MarkupContext = {
    baseUrl: settings.baseUrl,
    attachments: Object.fromEntries((raw.attachments ?? []).map((a) => [a.filename, a.content_url]))
  }
  // Journals without notes are field changes (status, assignee); the card shows only comments.
  const notes = (raw.journals ?? []).filter((j) => j.notes?.trim())
  const comments: RedmineComment[] = notes
    .slice(-COMMENTS_SHOWN)
    .reverse()
    .map((j) => ({
      id: j.id,
      author: j.user?.name ?? '',
      createdAt: Date.parse(j.created_on),
      private: Boolean(j.private_notes),
      text: toMarkdown(j.notes, COMMENT_LIMIT, settings, ctx)
    }))
  return {
    issue: toIssue(raw, settings.baseUrl, workspace),
    ...family,
    description: toMarkdown(raw.description, DESCRIPTION_LIMIT, settings, ctx),
    comments,
    commentsTotal: notes.length,
    attachments: raw.attachments?.length ?? 0,
    allowedStatuses: raw.allowed_statuses ? raw.allowed_statuses.map(toStatus) : null
  }
}

async function loadDetails(orca: OrcaWorkerApi, id: number, signal?: AbortSignal): Promise<RedmineDetails> {
  const settings = await readSettings(orca)
  const [{ issue }, index] = await Promise.all([
    // Redmine before 5.0 ignores allowed_statuses, and the panel then offers every status.
    redmine<{ issue: ApiIssue }>(
      orca,
      `/issues/${id}.json?include=journals,attachments,children,allowed_statuses`,
      { signal }
    ),
    indexOrEmpty(orca, settings.projectFolder)
  ])
  const family = await relatives(orca, issue, signal)
  return toDetails(issue, settings, workspaceFor(id, index), family)
}

/**
 * Writes the status (and an optional comment) and reads the issue back. Redmine drops a status
 * its workflow does not allow for the role and still answers 204, so the panel compares.
 */
async function setStatus(
  orca: OrcaWorkerApi,
  input: { id: number; statusId: number; notes?: string },
  signal: AbortSignal
): Promise<RedmineDetails> {
  const notes = (input.notes ?? '').trim()
  await redmine<void>(orca, `/issues/${input.id}.json`, {
    method: 'PUT',
    body: { issue: { status_id: input.statusId, ...(notes ? { notes } : {}) } },
    signal
  })
  // The issue may have left (or joined) the list; a fetch begun before the write must not win.
  connection++
  void refresh(orca).catch((e) => orca.log(`refresh after status change failed: ${(e as Error).message}`))
  return loadDetails(orca, input.id, signal)
}

async function indexOrEmpty(orca: OrcaWorkerApi, folder: string): Promise<WorkspaceIndex> {
  // Linking issues to workspaces is a nicety; a failure here must not hide the issue list.
  try {
    return await workspaceIndex(orca, folder)
  } catch (error) {
    orca.log(`workspace.list failed: ${(error as Error).message}`)
    return { all: [], folder, created: {} }
  }
}

async function currentUser(orca: OrcaWorkerApi, signal?: AbortSignal): Promise<string> {
  const cached = await orca.storage.get(USER)
  if (typeof cached === 'string' && cached) return cached
  const { user } = await redmine<{ user: { firstname: string; lastname: string } }>(
    orca,
    '/users/current.json',
    { signal }
  )
  const name = `${user.firstname} ${user.lastname}`.trim()
  await orca.storage.set(USER, name)
  return name
}

async function setStatusBar(orca: OrcaWorkerApi, snapshot: RedmineSnapshot | null, error?: string) {
  const update = error
    ? { text: 'Redmine: ошибка', tone: 'danger' as const, tooltip: error }
    : snapshot
      ? {
          text: `Redmine: ${snapshot.issues.length}`,
          tone: 'neutral' as const,
          tooltip: `Открытых задач на вас: ${snapshot.issues.length}. Нажмите, чтобы обновить.`
        }
      : {
          text: 'Redmine: не подключён',
          tone: 'warning' as const,
          tooltip: 'Укажите адрес Redmine и API-ключ в панели Redmine'
        }
  try {
    await orca.host.call('statusBar.update', { id: STATUS_ITEM, ...update })
  } catch (e) {
    // Browser clients and tests have no status bar; the panel still works.
    orca.log(`statusBar.update failed: ${(e as Error).message}`)
  }
}

async function notifyNew(orca: OrcaWorkerApi, snapshot: RedmineSnapshot, notify: boolean) {
  const known = await orca.storage.get(KNOWN_IDS)
  const ids = snapshot.issues.map((i) => i.id)
  await orca.storage.set(KNOWN_IDS, ids)
  // The first fetch has nothing to compare with: everything would look new.
  if (!notify || !Array.isArray(known)) return
  const fresh = snapshot.issues.filter((i) => !known.includes(i.id))
  if (fresh.length === 0) return
  const title =
    fresh.length === 1 ? `Новая задача #${fresh[0].id}` : `Новых задач в Redmine: ${fresh.length}`
  const body = fresh
    .slice(0, 3)
    .map((i) => `#${i.id} ${i.subject}`)
    .join('\n')
  try {
    const { delivered } = await orca.host.call('notifications.show', { title, body })
    // Without this the only trace of a muted notification would be its absence.
    if (!delivered) orca.log(`notifications.show not delivered: ${title}`)
  } catch (e) {
    orca.log(`notifications.show failed: ${(e as Error).message}`)
  }
}

// Bumped when the key, the address or an issue changes, so a fetch begun before cannot store its
// issues after.
let connection = 0
let inflight: { connection: number; promise: Promise<RedmineSnapshot> } | null = null

/**
 * One fetch at a time: overlapping ones (startup, a poll, an opening panel) would each find the
 * same issue new and notify about it again. Callers share the fetch, so none of them can abort it.
 */
function refresh(orca: OrcaWorkerApi): Promise<RedmineSnapshot> {
  if (inflight?.connection !== connection) {
    const current = { connection, promise: fetchSnapshot(orca, connection) }
    const done = () => {
      if (inflight === current) inflight = null
    }
    current.promise.then(done, done)
    inflight = current
  }
  return inflight.promise
}

async function fetchSnapshot(orca: OrcaWorkerApi, startedFor: number): Promise<RedmineSnapshot> {
  const settings = await readSettings(orca)
  try {
    const [{ issues }, user, index] = await Promise.all([
      redmine<{ issues: ApiIssue[] }>(
        orca,
        '/issues.json?assigned_to_id=me&status_id=open&sort=updated_on:desc&limit=100'
      ),
      currentUser(orca),
      indexOrEmpty(orca, settings.projectFolder)
    ])
    const snapshot: RedmineSnapshot = {
      user,
      issues: issues.map((raw) => toIssue(raw, settings.baseUrl, workspaceFor(raw.id, index))),
      fetchedAt: Date.now()
    }
    if (startedFor !== connection) return snapshot
    await orca.storage.set(SNAPSHOT, snapshot)
    await notifyNew(orca, snapshot, settings.notifyNew)
    await setStatusBar(orca, snapshot)
    orca.panels.post('redmine.updated', snapshot)
    return snapshot
  } catch (error) {
    if (startedFor === connection) await setStatusBar(orca, null, (error as Error).message)
    throw error
  }
}

async function cachedSnapshot(orca: OrcaWorkerApi): Promise<RedmineSnapshot | null> {
  const value = (await orca.storage.get(SNAPSHOT)) as RedmineSnapshot | null
  return value && Date.now() - value.fetchedAt < CACHE_MS ? value : null
}

function fillPrompt(template: string, values: { id: number; subject: string; url: string }): string {
  return template
    .replaceAll('{id}', String(values.id))
    .replaceAll('{subject}', values.subject)
    .replaceAll('{url}', values.url)
}

const starting = new Set<number>()

/** Continues in the issue's worktree if there is one, else creates it and starts the agent there. */
async function start(
  orca: OrcaWorkerApi,
  id: number,
  signal: AbortSignal
): Promise<{ workspace: string; prompt: string; created: boolean }> {
  const settings = await readSettings(orca)
  const index = await workspaceIndex(orca, settings.projectFolder)
  const own = workspaceFor(id, index)
  const template = own ? settings.continuePrompt : settings.startPrompt
  // The issue may come from the search box and not be in the list, so its subject is fetched.
  const subject = template.includes('{subject}')
    ? (await redmine<{ issue: ApiIssue }>(orca, `/issues/${id}.json`, { signal })).issue.subject
    : ''
  const prompt = fillPrompt(template, { id, subject, url: `${settings.baseUrl}/issues/${id}` })

  if (own) {
    await orca.host.call('agent.launch', { workspaceId: own.id, agent: settings.agent, prompt })
    await orca.host.call('workspace.open', { workspaceId: own.id })
    return { workspace: own.name, prompt, created: false }
  }

  const project = await targetProject(orca, index)
  const name = settings.worktreeName.replaceAll('{id}', String(id))
  const { workspaceId } = await orca.host
    .call('workspace.create', {
      projectId: project.id,
      ...(project.hostId ? { hostId: project.hostId } : {}),
      name,
      ...(settings.baseBranch ? { baseBranch: settings.baseBranch } : {}),
      ...(settings.skipSetup ? { setup: 'skip' as const } : {}),
      agent: settings.agent,
      prompt,
      open: true
    })
    .catch(explainCreateError)
  // Ids from create and from list are meant to match; the name is the fallback if they ever do not.
  const { workspaces } = await orca.host.call('workspace.list')
  const all = workspaces as Workspace[]
  const listed =
    all.find((w) => w.id === workspaceId) ??
    all.find((w) => w.projectId === project.id && w.name === name)
  await rememberCreated(orca, id, listed?.id ?? workspaceId, all)
  return { workspace: `${project.name} / ${listed?.name ?? name}`, prompt, created: true }
}

let pollTimer: ReturnType<typeof setTimeout> | undefined

function schedulePoll(orca: OrcaWorkerApi): void {
  clearTimeout(pollTimer)
  void readSettings(orca).then(({ pollMinutes }) => {
    if (!(pollMinutes > 0)) return
    pollTimer = setTimeout(async () => {
      if (await connected(orca)) {
        await refresh(orca).catch((e) => orca.log(`poll failed: ${(e as Error).message}`))
      }
      schedulePoll(orca)
    }, pollMinutes * 60_000)
  })
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  orca.panels.handle('redmine.state', async () => {
    const hasKey = Boolean(await orca.secrets.get(KEY_SECRET))
    const baseUrl = await storedBaseUrl(orca)
    return { configured: hasKey && Boolean(baseUrl), hasKey, baseUrl }
  })

  orca.panels.handle('redmine.connect', async ({ baseUrl, key }, { signal }) => {
    const url = normalizeUrl(baseUrl)
    const fresh = (key ?? '').trim()
    // An empty key field keeps the stored key, so moving to a new address needs no re-paste.
    const candidate = fresh || (await orca.secrets.get(KEY_SECRET))
    if (!candidate) fail('Вставьте API-ключ')
    // Validate before storing so a typo in either field never replaces a working connection.
    const { user } = await redmine<{ user: { firstname: string; lastname: string } }>(
      orca,
      '/users/current.json',
      { key: candidate, baseUrl: url, signal }
    ).catch((error: Error & { status?: number }) => {
      // Here a 404 means a wrong address or a disabled REST API, not a missing issue.
      if (error.status === 404) {
        fail(`По адресу ${url} нет Redmine API. Проверьте адрес и что в Redmine включён REST API.`)
      }
      throw error
    })
    connection++
    if (fresh) await orca.secrets.set(KEY_SECRET, fresh)
    await orca.storage.set(BASE_URL, url)
    const name = `${user.firstname} ${user.lastname}`.trim()
    await orca.storage.set(USER, name)
    await orca.storage.delete(SNAPSHOT)
    await orca.storage.delete(KNOWN_IDS)
    return { user: name, baseUrl: url }
  })

  // The address stays, so connecting again only needs the key.
  orca.panels.handle('redmine.clearKey', async () => {
    connection++
    await orca.secrets.delete(KEY_SECRET)
    for (const key of [SNAPSHOT, KNOWN_IDS, USER]) await orca.storage.delete(key)
    await setStatusBar(orca, null)
    return { ok: true as const }
  })

  orca.panels.handle('redmine.issues', async ({ force }) => {
    if (!force) {
      const cached = await cachedSnapshot(orca)
      if (cached) return cached
    }
    return refresh(orca)
  })

  orca.panels.handle('redmine.details', ({ id }, { signal }) => loadDetails(orca, id, signal))

  orca.panels.handle('redmine.setStatus', (input, { signal }) => setStatus(orca, input, signal))

  orca.panels.handle('redmine.statuses', async (_input, { signal }) => {
    const { issue_statuses } = await redmine<{
      issue_statuses: { id: number; name: string; is_closed?: boolean }[]
    }>(orca, '/issue_statuses.json', { signal })
    return { statuses: issue_statuses.map(toStatus) }
  })

  orca.panels.handle('redmine.start', async ({ id }, { signal }) => {
    // Creating a worktree takes seconds; a second press meanwhile would create another one.
    if (starting.has(id)) fail(`Агент по задаче #${id} уже запускается`)
    starting.add(id)
    try {
      return await start(orca, id, signal)
    } finally {
      starting.delete(id)
    }
  })

  orca.panels.handle('redmine.openWorkspace', async ({ workspaceId }) => {
    await orca.host.call('workspace.open', { workspaceId })
    return { ok: true as const }
  })

  orca.commands.register('redmine.refresh', async () => {
    const snapshot = await refresh(orca)
    return `Redmine: открытых задач на вас — ${snapshot.issues.length}`
  })

  orca.settings.onDidChange(({ key }) => {
    if (key === 'pollMinutes') schedulePoll(orca)
  })

  if (await connected(orca)) {
    const cached = (await orca.storage.get(SNAPSHOT)) as RedmineSnapshot | null
    if (cached) await setStatusBar(orca, cached)
    // The worker starts with Orca (it owns a status bar item), so this is the startup sync.
    void refresh(orca).catch((e) => orca.log(`startup refresh failed: ${(e as Error).message}`))
  } else {
    await setStatusBar(orca, null)
  }
  schedulePoll(orca)
}

export function deactivate(): void {
  clearTimeout(pollTimer)
}
