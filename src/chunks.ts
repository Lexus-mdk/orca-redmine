// Orca refuses a single text over 16 KiB; Cyrillic is two bytes a letter, so stay well under.
const CHUNK = 4_000

/** Splits Markdown at blank lines outside code fences, so no block is cut in half. */
export function chunks(markdown: string, size = CHUNK): string[] {
  const parts: string[] = []
  let current: string[] = []
  let length = 0
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (!inFence && !line.trim() && length >= size) {
      parts.push(current.join('\n'))
      current = []
      length = 0
      continue
    }
    current.push(line)
    length += line.length + 1
    // A single block longer than the limit (a pasted log) is cut anyway, fence closed and reopened.
    if (length >= size * 2) {
      if (inFence) current.push('```')
      parts.push(current.join('\n'))
      current = inFence ? ['```'] : []
      length = 0
    }
  }
  if (current.some((l) => l.trim())) parts.push(current.join('\n'))
  return parts
}
