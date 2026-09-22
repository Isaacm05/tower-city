/**
 * "Lines of code produced" out of one Claude Code CLI transcript — a deliberately approximate
 * signal, not an audited metric. Sums lines written across `Write`, `Edit` and `MultiEdit`
 * tool_use blocks.
 */
import fsp from 'node:fs/promises'
import { jsonLines } from './fsutil.mjs'

const lineCount = (text) => (typeof text === 'string' ? text.split('\n').length : 0)

/**
 * Cached against the file's own mtime, the same reasoning as `transcriptSkillCounts` in
 * `api.mjs` — a transcript only grows, and re-parsing megabytes of history on every poll for a
 * long-running thread would be wasted work.
 */
const locCache = new Map()
export async function transcriptLoc(file) {
  let stat
  try {
    stat = await fsp.stat(file)
  } catch {
    return null
  }
  const cached = locCache.get(file)
  if (cached && cached.mtime === stat.mtimeMs) return cached.loc

  let loc = 0
  try {
    for (const record of jsonLines(await fsp.readFile(file, 'utf8'))) {
      if (record.type !== 'assistant' || !Array.isArray(record.message?.content)) continue
      for (const block of record.message.content) {
        if (block?.type !== 'tool_use') continue
        if (block.name === 'Write') {
          loc += lineCount(block.input?.content)
        } else if (block.name === 'Edit') {
          loc += lineCount(block.input?.new_string)
        } else if (block.name === 'MultiEdit') {
          // Edit/MultiEdit only count `new_string`, never diffed against `old_string` — this
          // over-counts a line edited several times before landing, and still counts a line a
          // later edit reverts. Known, accepted approximation.
          for (const edit of block.input?.edits || []) loc += lineCount(edit?.new_string)
        }
      }
    }
  } catch {
    /* mid-write, or gone between the stat above and now — best effort */
  }
  locCache.set(file, { mtime: stat.mtimeMs, loc })
  return loc
}

/** Same as `transcriptLoc`, but callers summing across many threads never have to null-check. */
export async function countLinesOfCode(file) {
  const loc = await transcriptLoc(file)
  return loc === null ? 0 : loc
}
