/**
 * One self-checking case: a fake transcript with Write, Edit and MultiEdit tool_use blocks,
 * counted against a hand-computed expected total.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { countLinesOfCode } from '../server/lib/loc-counter.mjs'

const assistant = (content) => JSON.stringify({ type: 'assistant', message: { content } })

test('countLinesOfCode sums Write content, Edit new_string, and MultiEdit new_strings', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'loc-counter-'))
  const file = path.join(dir, 'session.jsonl')
  try {
    const lines = [
      assistant([
        { type: 'tool_use', name: 'Write', input: { content: 'line1\nline2\nline3' } }, // 3
        { type: 'tool_use', name: 'Edit', input: { old_string: 'ignored\nignored', new_string: 'a\nb' } }, // 2
      ]),
      assistant([
        {
          type: 'tool_use',
          name: 'MultiEdit',
          input: {
            edits: [
              { old_string: 'old', new_string: 'x\ny\nz' }, // 3
              { old_string: 'old2', new_string: 'q' }, // 1
            ],
          },
        },
        { type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } }, // ignored
      ]),
    ]
    await fsp.writeFile(file, lines.join('\n') + '\n')

    assert.equal(await countLinesOfCode(file), 9)
    assert.equal(await countLinesOfCode(path.join(dir, 'missing.jsonl')), 0)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
