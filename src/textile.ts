// Redmine stores descriptions and notes as Textile (the server-wide "Text formatting" setting);
// Orca's Markdown component only draws GitHub-flavoured Markdown, so the worker converts.
// Covers what Redmine users actually type, not the whole Textile spec.

export type MarkupContext = {
  baseUrl: string
  /** Attachment file name -> download URL, so `!scan.png!` can become a link. */
  attachments?: Record<string, string>
}

const HOLD = '\u0000'

/** Swaps fragments that must not be touched by later rules for placeholders. */
class Vault {
  private items: string[] = []
  keep(text: string): string {
    this.items.push(text)
    return `${HOLD}${this.items.length - 1}${HOLD}`
  }
  restore(text: string): string {
    const pattern = new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g')
    // Kept fragments may hold placeholders of their own (a link around code).
    let result = text
    while (pattern.test(result)) {
      result = result.replace(pattern, (_, i) => this.items[Number(i)])
    }
    return result
  }
}

const inlineCode = (text: string) => {
  const ticks = text.includes('`') ? '``' : '`'
  return `${ticks}${text}${ticks}`
}

function fence(code: string, language = ''): string {
  const body = code.replace(/^\n+|\n+$/g, '')
  const ticks = body.includes('```') ? '````' : '```'
  return `${ticks}${language}\n${body}\n${ticks}`
}

const decodeEntities = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')

// Letters and digits in any script: `\w` is ASCII-only and would treat Cyrillic as a boundary.
const WORD = '\\p{L}\\p{N}'
const OPEN = `(^|[^${WORD}*_\\\\])`
const CLOSE = `(?=$|[^${WORD}*_])`

function linkIssues(text: string, vault: Vault, baseUrl: string): string {
  return text.replace(
    new RegExp(`(^|[^${WORD}&/#])#(\\d{1,7})(?![${WORD}])`, 'gu'),
    (_, before, id) => `${before}${vault.keep(`[#${id}](${baseUrl}/issues/${id})`)}`
  )
}

function inline(source: string, ctx: MarkupContext, vault: Vault): string {
  let text = source

  text = text.replace(/<code>([\s\S]*?)<\/code>/g, (_, code) =>
    vault.keep(inlineCode(decodeEntities(code)))
  )
  text = text.replace(/(^|[^\p{L}\p{N}@])@([^@\n]+?)@(?![\p{L}\p{N}@])/gu, (_, before, code) =>
    `${before}${vault.keep(inlineCode(decodeEntities(code)))}`
  )

  // !image.png! and !>image.png(title)! — panels cannot show remote images, so link them.
  text = text.replace(/!([<>=]?)([^\s!()]+)(?:\(([^)]*)\))?!(?::(\S+))?/g, (whole, _a, src, title) => {
    if (!/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(src) && !/^https?:\/\//.test(src)) return whole
    const url = /^https?:\/\//.test(src) ? src : ctx.attachments?.[src]
    const label = `🖼 ${title || src.split('/').pop()}`
    return vault.keep(url ? `[${label}](${url})` : label)
  })

  // "text":url — the URL stops before trailing punctuation that belongs to the sentence.
  text = text.replace(/"([^"\n]+?)":((?:https?:\/\/|mailto:|\/)[^\s<>"]*[^\s<>".,;:!?)\]»])/g, (_, label, url) =>
    vault.keep(`[${label}](${url.startsWith('/') ? ctx.baseUrl + url : url})`)
  )
  // Bare URLs stay as they are but must not be read as emphasis (snake_case paths).
  text = text.replace(/https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]»]/g, (url) => vault.keep(url))

  text = linkIssues(text, vault, ctx.baseUrl)

  text = text.replace(new RegExp(`${OPEN}\\*\\*(?=\\S)(.+?)(?<=\\S)\\*\\*${CLOSE}`, 'gu'), '$1**$2**')
  text = text.replace(
    new RegExp(`${OPEN}\\*(?=[^\\s*])(.+?)(?<=[^\\s*])\\*${CLOSE}`, 'gu'),
    (_, before, body) => `${before}${vault.keep(`**${body}**`)}`
  )
  text = text.replace(
    new RegExp(`${OPEN}__?(?=[^\\s_])(.+?)(?<=[^\\s_])__?${CLOSE}`, 'gu'),
    (_, before, body) => `${before}*${body}*`
  )
  text = text.replace(/(^|\s)-(?=[^\s-])([^\n]*?[^\s-])-(?=$|[\s.,;:!?])/g, '$1~~$2~~')
  text = text.replace(/(^|\s)\+(?=\S)([^\n]*?\S)\+(?=$|[\s.,;:!?])/g, '$1$2')
  return text
}

// "- item" is not Textile, but people write it and Markdown would otherwise make it a list
// glued to the paragraph above with a stray backslash.
const LIST = /^(\s*)([*#]+|-)\s+(.*)$/
const HEADING = /^h([1-6])(?:[<>=(){}[\]\w.:;#-]*?)\.\s+(.*)$/
const QUOTE = /^bq(?:[(){}[\]\w.:;#-]*?)\.\s+(.*)$/
const PARAGRAPH = /^p(?:[<>=(){}[\]\w.:;#-]*?)\.\s+(.*)$/
const BLOCK_CODE = /^bc(?:[(){}[\]\w.:;#-]*?)\.\s+(.*)$/
const TABLE_ROW = /^\s*(?:table[^.]*\.\s*)?\|.*\|\s*$/

function tableCells(line: string): { cells: string[]; header: boolean } {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  let header = false
  const cells = inner.split('|').map((cell) => {
    // Cell modifiers: _. header, \2. colspan, /2. rowspan, <. >. =. alignment, {css}.
    const match = cell.match(/^\s*((?:_|\\\d+|\/\d+|[<>=^~]|\{[^}]*\}|\([^)]*\))+)\.\s?(.*)$/)
    if (!match) return cell.trim()
    if (match[1].includes('_')) header = true
    return match[2].trim()
  })
  return { cells, header }
}

function table(rows: string[], render: (text: string) => string): string {
  const parsed = rows.map(tableCells)
  const width = Math.max(...parsed.map((r) => r.cells.length))
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => render(cells[i] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`
  // Markdown requires a header row; Textile tables without one get an empty header.
  const [first, ...rest] = parsed[0].header ? parsed : [{ cells: [], header: true }, ...parsed]
  return [line(first.cells), `| ${Array(width).fill('---').join(' | ')} |`, ...rest.map((r) => line(r.cells))].join('\n')
}

export function textileToMarkdown(source: string, ctx: MarkupContext): string {
  const vault = new Vault()
  let text = source.replace(/\r\n?/g, '\n')

  text = text.replace(/<pre>\s*(?:<code(?:\s+class="([\w+-]+)")?>)?([\s\S]*?)(?:<\/code>)?\s*<\/pre>/g, (_, lang, code) =>
    `\n\n${vault.keep(fence(decodeEntities(code), lang ?? ''))}\n\n`
  )
  // {{collapse(Title) ... }} and friends: keep the content, drop the macro.
  text = text.replace(/\{\{collapse(?:\(([^)]*)\))?\s*/g, (_, title) => (title ? `\n\n**${title}**\n\n` : '\n\n'))
  text = text.replace(/\{\{(?:toc|>toc|<toc)\}\}/g, '').replace(/\n?\}\}\n?/g, '\n')

  const render = (line: string) => inline(line, ctx, vault)
  const out: string[] = []
  const lines = text.split('\n')
  let paragraph: string[] = []
  let quote = false

  const flush = () => {
    if (paragraph.length === 0) return
    // Textile turns a single newline inside a paragraph into <br>; Markdown needs a trailing "\".
    const body = paragraph.map(render).join('\\\n')
    out.push(quote ? body.split('\n').map((l) => `> ${l}`).join('\n') : body)
    out.push('')
    paragraph = []
    quote = false
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) {
      flush()
      continue
    }
    if (line.includes(HOLD) && /^\s*\u0000\d+\u0000\s*$/.test(line)) {
      flush()
      out.push(line.trim(), '')
      continue
    }
    const heading = line.match(HEADING)
    if (heading) {
      flush()
      // Sidebar width: h1 at Markdown level 1 would dwarf everything else.
      const level = Math.min(Number(heading[1]) + 1, 6)
      out.push(`${'#'.repeat(level)} ${render(heading[2])}`, '')
      continue
    }
    const bq = line.match(QUOTE)
    if (bq) {
      flush()
      quote = true
      paragraph.push(bq[1])
      continue
    }
    const bc = line.match(BLOCK_CODE)
    if (bc) {
      flush()
      const code = [bc[1]]
      while (i + 1 < lines.length && lines[i + 1].trim()) code.push(lines[++i])
      out.push(vault.keep(fence(code.join('\n'))), '')
      continue
    }
    if (TABLE_ROW.test(line)) {
      flush()
      const rows = [line]
      while (i + 1 < lines.length && TABLE_ROW.test(lines[i + 1])) rows.push(lines[++i])
      out.push(table(rows, render), '')
      continue
    }
    const list = line.match(LIST)
    // Redmine starts a list on any line, even right under a paragraph line ("Почему:\n* ...").
    if (list && !quote) {
      flush()
      const items: string[] = []
      let j = i
      while (j < lines.length) {
        const item = lines[j].match(LIST)
        if (!item) break
        const depth = item[2] === '-' ? 1 : item[2].length
        const marker = item[2].endsWith('#') ? '1.' : '-'
        items.push(`${'   '.repeat(depth - 1)}${marker} ${render(item[3])}`)
        j++
      }
      i = j - 1
      out.push(...items, '')
      continue
    }
    const p = line.match(PARAGRAPH)
    paragraph.push(p ? p[1] : line)
  }
  flush()

  return vault.restore(out.join('\n')).replace(/\n{3,}/g, '\n\n').trim()
}

/** Markdown-formatted Redmines need only the #123 issue links. */
export function markdownWithIssueLinks(source: string, ctx: MarkupContext): string {
  const vault = new Vault()
  let text = source.replace(/\r\n?/g, '\n')
  text = text.replace(/(```[\s\S]*?```|`[^`\n]+`)/g, (code) => vault.keep(code))
  return vault.restore(linkIssues(text, vault, ctx.baseUrl))
}
