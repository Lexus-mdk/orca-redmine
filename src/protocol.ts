// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.

/** One Redmine issue, trimmed to what the panel shows. */
export type RedmineIssue = {
  id: number
  subject: string
  project: string
  tracker: string
  status: string
  statusId: number
  priority: string
  author: string
  /** Empty when nobody is assigned. */
  assignee: string
  doneRatio: number
  updatedAt: number
  url: string
  /** Orca workspace already opened for this issue (a project worktree named by its number). */
  workspaceId: string | null
}

export type RedmineComment = {
  id: number
  author: string
  createdAt: number
  private: boolean
  /** Converted to Markdown by the worker. */
  text: string
}

export type RedmineSubtask = {
  id: number
  subject: string
  tracker: string
  status: string
  closed: boolean
  assignee: string
  doneRatio: number
  /** 1 for a direct child, 2 for its child, and so on. */
  depth: number
}

/** What the card shows; fetched when it opens, so the list stays small. */
export type RedmineDetails = {
  issue: RedmineIssue
  /** Subject is empty when the parent is in a project the key cannot read. */
  parent: { id: number; subject: string; status: string } | null
  /** The whole subtree, depth-first, in Redmine's order. */
  subtasks: RedmineSubtask[]
  /** Converted to Markdown by the worker. */
  description: string
  /** Newest first. */
  comments: RedmineComment[]
  /** All comments the issue has, when more than `comments` holds. */
  commentsTotal: number
  attachments: number
  /**
   * Statuses Redmine's workflow lets the key's owner set, the current one included; empty when
   * they may not change it, null when Redmine is older than 5.0 and does not say.
   */
  allowedStatuses: RedmineStatus[] | null
}

/** An issue status as Redmine lists it in Administration → Issue statuses. */
export type RedmineStatus = {
  id: number
  name: string
  closed: boolean
}

export type RedmineSnapshot = {
  user: string
  issues: RedmineIssue[]
  fetchedAt: number
}

declare module 'orca' {
  interface PluginRequests {
    /** Connected means both a key and an address are stored; the address outlives a forgotten key. */
    'redmine.state': { output: { configured: boolean; hasKey: boolean; baseUrl: string } }
    /**
     * Checks the address and key against /users/current.json and stores them only if Redmine
     * accepts them. An empty `key` reuses the stored one.
     */
    'redmine.connect': {
      input: { baseUrl: string; key?: string }
      output: { user: string; baseUrl: string }
    }
    'redmine.clearKey': { output: { ok: true } }
    /** Every status in Redmine's own order; the panel sorts its groups by it. */
    'redmine.statuses': { output: { statuses: RedmineStatus[] } }
    /** Open issues assigned to the key's owner; without `force` a fresh cache is reused. */
    'redmine.issues': { input: { force?: boolean }; output: RedmineSnapshot }
    /** Any issue by number with description and comments: the card and the search box. */
    'redmine.details': { input: { id: number }; output: RedmineDetails }
    /**
     * Sets the status, with an optional comment, and answers with the card read back. A status
     * the workflow forbids Redmine skips silently, keeping the comment: compare `issue.statusId`.
     */
    'redmine.setStatus': {
      input: { id: number; statusId: number; notes?: string }
      output: RedmineDetails
    }
    /** Starts an agent in the issue's worktree; `created` when that worktree was made just now. */
    'redmine.start': {
      input: { id: number }
      output: { workspace: string; prompt: string; created: boolean }
    }
    'redmine.openWorkspace': { input: { workspaceId: string }; output: { ok: true } }
  }
  interface PluginPanelEvents {
    /** Posted after every refresh, background polls included. */
    'redmine.updated': RedmineSnapshot
  }
}
