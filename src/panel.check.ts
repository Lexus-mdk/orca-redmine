// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh
// host. The worker is stubbed by name so check never reaches a real Redmine.
import { defineCheck } from 'orca/testing'

const issue = (id: number, statusId: number, workspaceId: string | null = null) => ({
  id,
  subject: `Проверочная задача ${id}`,
  project: 'Демо-проект',
  tracker: 'Ошибка',
  status: statusId === 1 ? 'Новая' : 'В работе',
  statusId,
  priority: 'Нормальный',
  author: 'Автор',
  assignee: statusId === 1 ? '' : 'Смирнова Анна',
  doneRatio: 30,
  updatedAt: 0,
  url: `https://redmine.test/issues/${id}`,
  workspaceId
})

const list = () => ({
  user: 'Анна Смирнова',
  issues: [issue(14605, 2, 'ws'), issue(14700, 1), issue(14701, 1)],
  fetchedAt: 0
})

const state = (configured: boolean) => () => ({
  configured,
  hasKey: configured,
  baseUrl: configured ? 'https://redmine.test' : ''
})

const statuses = () => ({
  statuses: [
    { id: 1, name: 'Новая', closed: false },
    { id: 2, name: 'В работе', closed: false },
    { id: 5, name: 'Закрыта', closed: true }
  ]
})

export default defineCheck({
  noKey: { requests: { 'redmine.state': state(false) } },
  list: {
    requests: { 'redmine.state': state(true), 'redmine.issues': list, 'redmine.statuses': statuses }
  },
  customOrder: {
    requests: { 'redmine.state': state(true), 'redmine.issues': list, 'redmine.statuses': statuses },
    persisted: { plugin: { statusOrder: [2, 1] } }
  },
  selected: {
    requests: {
      'redmine.state': state(true),
      'redmine.issues': list,
      'redmine.details': () => ({
        issue: issue(14605, 2, 'ws'),
        parent: { id: 14462, subject: 'Новый раздел «Личный кабинет»', status: 'Новая' },
        subtasks: [
          { id: 16001, subject: 'Бэкенд: API заявок', tracker: 'Разработка', status: 'В работе', closed: false, assignee: 'Смирнова Анна', doneRatio: 40, depth: 1 },
          { id: 16002, subject: 'Миграция таблиц', tracker: 'Разработка', status: 'Закрыта', closed: true, assignee: 'Смирнова Анна', doneRatio: 100, depth: 2 },
          { id: 16003, subject: 'Тестирование', tracker: 'Тестирование', status: 'Новая', closed: false, assignee: '', doneRatio: 0, depth: 1 }
        ],
        description:
          '### Проблема\n\nПосле выкатки с `FEATURE_PREVIEW_ENABLED=1`:\n\n- контейнер — **3,65 ГБ**;\n   - вложенный пункт\n\n```\nif not parsed:\n    return None\n```\n\n| Поле | Было |\n| --- | --- |\n| дата | null |',
        comments: [
          { id: 2, author: 'Смирнова Анна', createdAt: 0, private: true, text: 'Проверила на стенде, см. [#15363](https://redmine.test/issues/15363).' },
          { id: 1, author: 'Петров Иван', createdAt: 0, private: false, text: 'Нужен замер **до** и после.' }
        ],
        commentsTotal: 2,
        attachments: 1,
        allowedStatuses: statuses().statuses
      })
    },
    persisted: { plugin: { selectedId: 14605 } }
  },
  failed: {
    requests: {
      'redmine.state': state(true),
      'redmine.issues': () => {
        throw new Error('Redmine не ответил за 15 с (https://redmine.test)')
      }
    }
  }
})
