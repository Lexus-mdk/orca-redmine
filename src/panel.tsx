// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Collapsible,
  EmptyState,
  Heading,
  IconButton,
  Input,
  KeyValue,
  Link,
  List,
  ListItem,
  Markdown,
  plugin,
  Progress,
  read,
  RelativeTime,
  Row,
  Select,
  set,
  shell,
  Skeleton,
  Spinner,
  Stack,
  Text,
  Textarea,
  type PanelContext
} from 'orca'
import { chunks } from './chunks'
import type {
  RedmineComment,
  RedmineDetails,
  RedmineIssue,
  RedmineSnapshot,
  RedmineStatus,
  RedmineSubtask
} from './protocol'

/** null until the worker says whether a key and an address are stored. */
const configured = atom<boolean | null>(null)
/** A stored key lets the form change only the address. */
const hasKey = atom(false)
/** The address the worker stores; the form edits a draft so Cancel can put it back. */
const savedUrl = atom('')
const urlDraft = atom('')
const snapshot = atom<RedmineSnapshot | null>(null)
const loading = atom(false)
const error = atom<string | null>(null)
const notice = atom<string | null>(null)
const busy = atom<string | null>(null)
const editingKey = atom(false)
const keyDraft = atom('')
// Keyed, so a hot reload keeps what the person typed; the open card survives reopening the panel.
const query = atom('query', '')
const selectedId = atom<number | null>('selectedId', null, { persist: 'plugin' })
/** Description and comments of the open card; fetched when it opens. */
const details = atom<RedmineDetails | null>(null)
const detailsLoading = atom(false)
/** Redmine's statuses in its own order; null until fetched, and the list falls back to ids. */
const statuses = atom<RedmineStatus[] | null>(null)
/** Status ids the person moved up front; the rest follow in Redmine's order. */
const statusOrder = atom<number[]>('statusOrder', [], { persist: 'plugin' })
const ordering = atom(false)
/** The status form of the open card: chosen status id as Select's string, and a comment. */
const statusEditing = atom(false)
const statusDraft = atom('')
const statusNote = atom('')

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function load(force = false): Promise<void> {
  set(loading, true)
  set(error, null)
  try {
    set(snapshot, await plugin.request('redmine.issues', { force }, { timeoutMs: 45_000 }))
  } catch (e) {
    set(error, message(e))
  } finally {
    set(loading, false)
  }
}

async function open(id: number): Promise<void> {
  set(selectedId, id)
  if (read(details)?.issue.id !== id) {
    set(details, null)
    set(statusEditing, false)
  }
  set(detailsLoading, true)
  set(error, null)
  try {
    const answer = await plugin.request('redmine.details', { id }, { timeoutMs: 45_000 })
    // A slower answer for a card the person already left must not replace the current one.
    if (read(selectedId) === id) set(details, answer)
  } catch (e) {
    if (read(selectedId) === id) set(error, `#${id}: ${message(e)}`)
  } finally {
    if (read(selectedId) === id) set(detailsLoading, false)
  }
}

function close(): void {
  set(selectedId, null)
  set(details, null)
  set(detailsLoading, false)
  set(statusEditing, false)
}

async function loadStatuses(): Promise<void> {
  try {
    set(statuses, (await plugin.request('redmine.statuses')).statuses)
  } catch {
    // Grouping still works without them, ordered by status id.
  }
}

async function init(): Promise<void> {
  try {
    const state = await plugin.request('redmine.state')
    set(savedUrl, state.baseUrl)
    set(urlDraft, state.baseUrl)
    set(hasKey, state.hasKey)
    set(configured, state.configured)
    if (!state.configured) return
    const reopen = read(selectedId)
    await Promise.all([load(), loadStatuses(), reopen ? open(reopen) : null])
  } catch (e) {
    set(configured, false)
    set(error, message(e))
  }
}

function canConnect(): boolean {
  return Boolean(read(urlDraft).trim()) && (read(hasKey) || Boolean(read(keyDraft).trim()))
}

async function connect(): Promise<void> {
  if (!canConnect() || read(busy) === 'key') return
  set(busy, 'key')
  set(error, null)
  try {
    const { user, baseUrl } = await plugin.request('redmine.connect', {
      baseUrl: read(urlDraft),
      key: read(keyDraft)
    })
    set(savedUrl, baseUrl)
    set(urlDraft, baseUrl)
    set(keyDraft, '')
    set(hasKey, true)
    set(editingKey, false)
    set(configured, true)
    set(statuses, null)
    close()
    set(notice, `Подключено к ${baseUrl}: ${user}`)
    await Promise.all([load(true), loadStatuses()])
  } catch (e) {
    set(error, message(e))
  } finally {
    set(busy, null)
  }
}

async function forgetKey(): Promise<void> {
  await plugin.request('redmine.clearKey')
  set(snapshot, null)
  close()
  set(hasKey, false)
  set(configured, false)
  set(editingKey, false)
  set(ordering, false)
  set(notice, null)
}

/** Open statuses in the person's order: theirs first, then Redmine's, then unknown ones by id. */
function orderedStatuses(): { id: number; name: string }[] {
  const names = new Map<number, string>()
  for (const s of read(statuses) ?? []) if (!s.closed) names.set(s.id, s.name)
  // Statuses Redmine did not list (the request failed, or one was added since) still get a place.
  const extra = new Map<number, string>()
  for (const i of read(snapshot)?.issues ?? []) {
    if (!names.has(i.statusId)) extra.set(i.statusId, i.status)
  }
  for (const id of [...extra.keys()].sort((a, b) => a - b)) names.set(id, extra.get(id) ?? '')
  const custom = read(statusOrder).filter((id) => names.has(id))
  const rest = [...names.keys()].filter((id) => !custom.includes(id))
  return [...custom, ...rest].map((id) => ({ id, name: names.get(id) ?? '' }))
}

function moveStatus(id: number, step: -1 | 1): void {
  const ids = orderedStatuses().map((s) => s.id)
  const from = ids.indexOf(id)
  const to = from + step
  if (from < 0 || to < 0 || to >= ids.length) return
  ;[ids[from], ids[to]] = [ids[to], ids[from]]
  set(statusOrder, ids)
}

function withScheme(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function matches(issue: RedmineIssue, text: string): boolean {
  const q = text.trim().toLowerCase().replace(/^#/, '')
  if (!q) return true
  return String(issue.id).includes(q) || issue.subject.toLowerCase().includes(q)
}

function search(text: string): void {
  const id = Number(text.trim().replace(/^#/, ''))
  if (Number.isInteger(id) && id > 0) void open(id)
}

async function start(issue: RedmineIssue): Promise<void> {
  set(busy, 'start')
  set(error, null)
  set(notice, null)
  try {
    // Creating a worktree runs git and the project's setup script, which can take a while.
    const { workspace, prompt, created } = await plugin.request(
      'redmine.start',
      { id: issue.id },
      { timeoutMs: 120_000 }
    )
    set(
      notice,
      created
        ? `Создан worktree «${workspace}», агент запущен: ${prompt}`
        : `Агент запущен в «${workspace}»: ${prompt}`
    )
    // The new worktree turns the button into "Продолжить" and shows up in the list.
    if (created) await Promise.all([load(true), read(selectedId) === issue.id ? open(issue.id) : null])
  } catch (e) {
    set(error, message(e))
  } finally {
    set(busy, null)
  }
}

/** Where the issue can go: Redmine's workflow when it says, else every status but the current. */
function statusChoices(full: RedmineDetails): RedmineStatus[] {
  const all = full.allowedStatuses ?? read(statuses) ?? []
  return all.filter((s) => s.id !== full.issue.statusId)
}

function editStatus(): void {
  set(statusDraft, '')
  set(statusNote, '')
  set(statusEditing, true)
  if (!read(statuses)) void loadStatuses()
}

async function saveStatus(issue: RedmineIssue): Promise<void> {
  const statusId = Number(read(statusDraft))
  if (!statusId || read(busy) === 'status') return
  const known = [...(read(details)?.allowedStatuses ?? []), ...(read(statuses) ?? [])]
  const wanted = known.find((s) => s.id === statusId)?.name
  set(busy, 'status')
  set(error, null)
  set(notice, null)
  try {
    const answer = await plugin.request(
      'redmine.setStatus',
      { id: issue.id, statusId, notes: read(statusNote) },
      { timeoutMs: 45_000 }
    )
    if (read(selectedId) === issue.id) set(details, answer)
    // The write went through either way, comment included; a retry must not post it twice.
    set(statusNote, '')
    if (answer.issue.statusId === statusId) {
      set(statusEditing, false)
      set(notice, `#${issue.id}: статус «${answer.issue.status}»`)
    } else {
      set(
        error,
        `Redmine оставил статус «${answer.issue.status}»${wanted ? `, а не «${wanted}»` : ''}: переход не разрешён workflow для вашей роли.`
      )
    }
  } catch (e) {
    set(error, message(e))
  } finally {
    set(busy, null)
  }
}

async function openWorkspace(workspaceId: string): Promise<void> {
  try {
    await plugin.request('redmine.openWorkspace', { workspaceId })
  } catch (e) {
    set(error, message(e))
  }
}

async function openInBrowser(url: string): Promise<void> {
  try {
    await shell.openExternal(url)
  } catch (e) {
    set(error, message(e))
  }
}

export function setup(ctx: PanelContext): void {
  // Background polls in the worker keep every open panel current without it asking.
  ctx.subscriptions.push(plugin.on('redmine.updated', (next) => set(snapshot, next)))
  void init()
}

function KeyForm() {
  const url = read(urlDraft).trim()
  const keepsKey = read(hasKey)
  const saving = read(busy) === 'key'
  const account = url ? `${withScheme(url)}/my/account` : ''
  return (
    <Card
      title="Подключение к Redmine"
      description="Адрес — тот, по которому Redmine открывается в браузере. API-ключ — на странице «Моя учётная запись» → «Ключ доступа к API»."
    >
      <Stack gap="sm">
        <Input
          label="Адрес Redmine"
          value={read(urlDraft)}
          placeholder="https://redmine.example.com"
          disabled={saving}
          onChange={(value) => set(urlDraft, value)}
          onSubmit={() => void connect()}
        />
        <Input
          label="API-ключ"
          type="password"
          value={read(keyDraft)}
          placeholder={keepsKey ? 'Оставьте пустым, чтобы не менять' : '40 символов'}
          disabled={saving}
          onChange={(value) => set(keyDraft, value)}
          onSubmit={() => void connect()}
        />
        {account ? (
          <Text muted size="xs">
            Где взять ключ: <Link onPress={() => void openInBrowser(account)}>{account}</Link>
          </Text>
        ) : null}
        <Text muted size="xs">
          Адрес и ключ проверяются запросом к Redmine перед сохранением. Ключ хранится в
          зашифрованном хранилище плагина.
        </Text>
        <Row gap="xs">
          <Button tone="accent" disabled={saving || !canConnect()} onPress={connect}>
            {saving ? 'Проверяю…' : 'Подключить'}
          </Button>
          {read(configured) ? (
            <Button
              variant="ghost"
              onPress={() => {
                set(urlDraft, read(savedUrl))
                set(keyDraft, '')
                set(editingKey, false)
              }}
            >
              Отмена
            </Button>
          ) : null}
        </Row>
      </Stack>
    </Card>
  )
}

function RichText({ content }: { content: string }) {
  const parts = chunks(content)
  if (parts.length === 1) return <Markdown content={parts[0]} />
  return (
    <Stack gap="sm">
      {parts.map((part, i) => (
        <Markdown key={String(i)} content={part} />
      ))}
    </Stack>
  )
}

function Comment({ comment }: { comment: RedmineComment }) {
  return (
    <Box border radius="md" padding="sm" direction="column" gap="xs">
      <Row gap="xs" align="center" wrap>
        <Text weight="medium" size="sm">
          {comment.author}
        </Text>
        <Text muted size="xs">
          <RelativeTime at={comment.createdAt} />
        </Text>
        {comment.private ? <Badge tone="warning">приватный</Badge> : null}
      </Row>
      <RichText content={comment.text} />
    </Box>
  )
}

// Each level of nesting shifts a subtask right by this many pixels.
const INDENT = 14

function SubtaskRow({ task }: { task: RedmineSubtask }) {
  const row = (
    <Box border radius="md" grow>
      <List>
        <ListItem
          title={`#${task.id} ${task.subject}`}
          description={[task.status, task.assignee || 'не назначена', task.tracker]
            .filter(Boolean)
            .join(' · ')}
          icon={task.closed ? 'check' : undefined}
          onPress={() => void open(task.id)}
        />
      </List>
    </Box>
  )
  if (task.depth === 1) return row
  return (
    <Box direction="row">
      <Box width={(task.depth - 1) * INDENT} shrink={false} />
      {row}
    </Box>
  )
}

function Subtasks({ tasks }: { tasks: RedmineSubtask[] }) {
  const closed = tasks.filter((t) => t.closed).length
  return (
    <Collapsible title={`Подзадачи · закрыто ${closed} из ${tasks.length}`} defaultOpen>
      <Stack gap="xs">
        <Progress label="Закрыто подзадач" labelHidden value={Math.round((closed / tasks.length) * 100)} />
        {tasks.map((task) => (
          <SubtaskRow key={String(task.id)} task={task} />
        ))}
      </Stack>
    </Collapsible>
  )
}

function StatusForm({ issue, full }: { issue: RedmineIssue; full: RedmineDetails }) {
  const choices = statusChoices(full)
  const saving = read(busy) === 'status'
  const cancel = (
    <Button variant="ghost" disabled={saving} onPress={() => set(statusEditing, false)}>
      Отмена
    </Button>
  )
  if (choices.length === 0) {
    return (
      <Box border radius="md" padding="sm" direction="column" gap="sm">
        <Text muted size="sm">
          {full.allowedStatuses
            ? 'Redmine не даёт вам менять статус этой задачи.'
            : 'Загружаю статусы…'}
        </Text>
        <Row>{cancel}</Row>
      </Box>
    )
  }
  return (
    <Box border radius="md" padding="sm" direction="column" gap="sm">
      <Select
        label="Новый статус"
        value={read(statusDraft)}
        placeholder="Выберите статус"
        options={choices.map((s) => ({
          value: String(s.id),
          label: s.closed ? `${s.name} (закрывает задачу)` : s.name
        }))}
        disabled={saving}
        onChange={(value) => set(statusDraft, value)}
      />
      <Textarea
        label="Комментарий"
        value={read(statusNote)}
        placeholder="Необязательно"
        rows={3}
        disabled={saving}
        onChange={(value) => set(statusNote, value)}
        onSubmit={() => void saveStatus(issue)}
      />
      <Row gap="xs">
        <Button tone="accent" disabled={saving || !read(statusDraft)} onPress={() => saveStatus(issue)}>
          {saving ? 'Сохраняю…' : 'Сохранить'}
        </Button>
        {cancel}
      </Row>
    </Box>
  )
}

function IssueCard({ issue }: { issue: RedmineIssue }) {
  const starting = read(busy) === 'start'
  const workspaceId = issue.workspaceId
  const info = read(details)
  const full = info?.issue.id === issue.id ? info : null
  const parent = full?.parent ?? null
  return (
    <Card title={`#${issue.id} ${issue.subject}`}>
      <Stack gap="sm">
        <Row gap="xs" wrap align="center">
          <Badge tone="accent">{issue.status}</Badge>
          <Badge>{issue.priority}</Badge>
          {workspaceId ? <Badge tone="success">есть workspace</Badge> : null}
          {/* Allowed statuses come with the details, so the button waits for them. */}
          {full && !read(statusEditing) ? (
            <Button size="xs" variant="ghost" icon="edit" onPress={editStatus}>
              Сменить статус
            </Button>
          ) : null}
        </Row>
        {full && read(statusEditing) ? <StatusForm issue={issue} full={full} /> : null}
        {parent ? (
          <Text size="sm">
            Родительская:{' '}
            <Link onPress={() => void open(parent.id)}>
              {`#${parent.id}${parent.subject ? ` ${parent.subject}` : ''}`}
            </Link>
            {parent.status ? ` · ${parent.status}` : ''}
          </Text>
        ) : null}
        <KeyValue
          items={[
            { label: 'Проект', value: issue.project },
            { label: 'Трекер', value: issue.tracker },
            { label: 'Автор', value: issue.author },
            {
              label: 'Исполнитель',
              value: issue.assignee || 'не назначен',
              tone: issue.assignee ? undefined : 'warning'
            },
            { label: 'Готовность', value: `${issue.doneRatio}%` },
            ...(full && full.attachments > 0 ? [{ label: 'Вложений', value: full.attachments }] : [])
          ]}
        />
        <Text muted size="xs">
          Обновлена <RelativeTime at={issue.updatedAt} />
        </Text>
        <Row gap="xs" wrap>
          <Button tone="accent" icon="agent" disabled={starting} onPress={() => start(issue)}>
            {starting
              ? workspaceId
                ? 'Запускаю…'
                : 'Создаю worktree…'
              : workspaceId
                ? 'Продолжить'
                : 'Взять в работу'}
          </Button>
          {workspaceId ? (
            <Button variant="outline" icon="branch" onPress={() => openWorkspace(workspaceId)}>
              Workspace
            </Button>
          ) : null}
          <Button variant="outline" icon="open-external" onPress={() => openInBrowser(issue.url)}>
            Redmine
          </Button>
        </Row>
        {!full && read(detailsLoading) ? <Skeleton lines={4} label="Загружаю описание" /> : null}
        {full && full.subtasks.length > 0 ? <Subtasks tasks={full.subtasks} /> : null}
        {full && full.description ? (
          <Collapsible title="Описание" defaultOpen>
            <RichText content={full.description} />
          </Collapsible>
        ) : null}
        {full ? (
          <Collapsible
            title={full.commentsTotal ? `Комментарии · ${full.commentsTotal}` : 'Комментариев нет'}
            defaultOpen={full.commentsTotal > 0}
            disabled={full.commentsTotal === 0}
          >
            <Stack gap="sm">
              {full.comments.map((comment) => (
                <Comment key={String(comment.id)} comment={comment} />
              ))}
              {full.commentsTotal > full.comments.length ? (
                <Text muted size="xs">
                  Показаны последние {full.comments.length} из {full.commentsTotal}; остальные — в
                  Redmine.
                </Text>
              ) : null}
            </Stack>
          </Collapsible>
        ) : null}
      </Stack>
    </Card>
  )
}

function IssueRow({ issue, current }: { issue: RedmineIssue; current: boolean }) {
  return (
    // Orca draws ListItem only inside a List, so each bordered box holds a one-item list.
    <Box border={current ? 'accent' : true} radius="md" background={current ? 'muted' : 'none'}>
      <List>
        <ListItem
          title={`#${issue.id} ${issue.subject}`}
          description={[issue.tracker, issue.priority, issue.workspaceId ? 'workspace' : '']
            .filter(Boolean)
            .join(' · ')}
          icon={issue.workspaceId ? 'branch' : undefined}
          current={current}
          onPress={() => (current ? close() : void open(issue.id))}
        />
      </List>
    </Box>
  )
}

function IssueGroups({ issues }: { issues: RedmineIssue[] }) {
  const groups = new Map<number, RedmineIssue[]>()
  for (const issue of issues) {
    groups.set(issue.statusId, [...(groups.get(issue.statusId) ?? []), issue])
  }
  const rank = new Map(orderedStatuses().map((s, i) => [s.id, i]))
  const current = read(selectedId)
  return (
    <Stack gap="xs">
      {[...groups.entries()]
        .sort(([a], [b]) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || a - b)
        .map(([statusId, items]) => (
          <Collapsible key={String(statusId)} title={`${items[0].status} · ${items.length}`} defaultOpen>
            <Stack gap="xs">
              {items.map((issue) => (
                <IssueRow key={String(issue.id)} issue={issue} current={issue.id === current} />
              ))}
            </Stack>
          </Collapsible>
        ))}
    </Stack>
  )
}

function StatusOrder() {
  const list = orderedStatuses()
  const custom = read(statusOrder).length > 0
  return (
    <Card
      title="Порядок статусов"
      description="В этом порядке группы идут в списке задач. Закрытые статусы в списке не появляются."
    >
      <Stack gap="xs">
        {list.length === 0 ? <Text muted size="sm">Статусы ещё не загружены.</Text> : null}
        {list.map((status, i) => (
          <Box key={String(status.id)} border radius="md" padding="xs" direction="row" align="center" gap="xs">
            <Box grow>
              <Text size="sm">{status.name}</Text>
            </Box>
            <Button
              size="xs"
              variant="ghost"
              tooltip={`«${status.name}» выше`}
              disabled={i === 0}
              onPress={() => moveStatus(status.id, -1)}
            >
              ↑
            </Button>
            <Button
              size="xs"
              variant="ghost"
              tooltip={`«${status.name}» ниже`}
              disabled={i === list.length - 1}
              onPress={() => moveStatus(status.id, 1)}
            >
              ↓
            </Button>
          </Box>
        ))}
        <Row gap="xs">
          <Button tone="accent" onPress={() => set(ordering, false)}>
            Готово
          </Button>
          <Button variant="ghost" disabled={!custom} onPress={() => set(statusOrder, [])}>
            Как в Redmine
          </Button>
        </Row>
      </Stack>
    </Card>
  )
}

export default function Panel() {
  const isConfigured = read(configured)
  const err = read(error)
  const info = read(notice)
  if (isConfigured === null) return <Spinner label="Загрузка" />

  const alerts =
    err || info ? (
      <Stack gap="sm">
        {err ? (
          <Callout tone="danger" icon="error">
            {err}
          </Callout>
        ) : null}
        {info ? (
          <Callout tone="success" icon="check">
            {info}
          </Callout>
        ) : null}
      </Stack>
    ) : null

  if (!isConfigured || read(editingKey)) {
    return (
      <Stack gap="md">
        {alerts}
        <KeyForm />
      </Stack>
    )
  }

  const data = read(snapshot)
  const text = read(query)
  const visible = data ? data.issues.filter((i) => matches(i, text)) : []
  const id = read(selectedId)
  // A number from the search box may not be in the list: then the card comes from details.
  // Details also win when newer, so a status just changed shows before the list catches up.
  const listed = data?.issues.find((i) => i.id === id)
  const loaded = read(details)
  const fetched = loaded && loaded.issue.id === id ? loaded.issue : undefined
  const selected =
    listed && fetched ? (fetched.updatedAt > listed.updatedAt ? fetched : listed) : (listed ?? fetched ?? null)

  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Row gap="xs" align="center">
          <Heading level={2}>Мои задачи</Heading>
          {data ? <Badge tone="accent">{data.issues.length}</Badge> : null}
        </Row>
        <Row gap="xs">
          <IconButton
            icon="refresh"
            label="Обновить"
            variant="ghost"
            disabled={read(loading)}
            onPress={() => {
              const openId = read(selectedId)
              void load(true)
              if (openId) void open(openId)
            }}
          />
          <IconButton
            icon="layers"
            label="Порядок статусов"
            variant={read(ordering) ? 'outline' : 'ghost'}
            onPress={() => {
              const next = !read(ordering)
              set(ordering, next)
              if (next && !read(statuses)) void loadStatuses()
            }}
          />
          <IconButton
            icon="settings"
            label="Адрес Redmine и API-ключ"
            variant="ghost"
            onPress={() => {
              set(keyDraft, '')
              set(editingKey, true)
            }}
          />
          <IconButton icon="delete" label="Забыть API-ключ" variant="ghost" onPress={forgetKey} />
        </Row>
      </Row>
      {read(ordering) ? <StatusOrder /> : null}
      <Input
        label="Поиск"
        labelHidden
        type="search"
        value={text}
        placeholder="Номер или текст; Enter — открыть любую задачу по номеру"
        onChange={(value) => set(query, value)}
        onSubmit={search}
      />
      {alerts}
      {id && !selected && read(detailsLoading) ? <Spinner label="Ищу задачу" /> : null}
      {selected ? (
        <Stack gap="xs">
          {/* Above the card: a long description would push a bottom button out of view. */}
          <Row justify="end">
            <Button variant="ghost" size="xs" icon="close" onPress={close}>
              Закрыть карточку
            </Button>
          </Row>
          <IssueCard issue={selected} />
        </Stack>
      ) : null}
      {!data && read(loading) ? <Spinner label="Загружаю задачи" /> : null}
      {data && visible.length === 0 ? (
        <EmptyState
          icon="check"
          title={text ? 'Ничего не нашлось' : 'Открытых задач нет'}
          description={text ? 'Enter — найти задачу по номеру в Redmine' : undefined}
        />
      ) : null}
      {visible.length > 0 ? <IssueGroups issues={visible} /> : null}
      {data ? (
        <Text muted size="xs">
          {data.user} · обновлено <RelativeTime at={data.fetchedAt} />
        </Text>
      ) : null}
    </Stack>
  )
}
