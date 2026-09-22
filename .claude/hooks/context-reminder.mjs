#!/usr/bin/env node
/**
 * Project-level Stop hook: reminds a session to keep .agent-context.md up to date before it
 * ends. Committed to the repo (via bot-crossing-hive's project setup) so every teammate gets
 * this nudge, not just whoever happened to configure it personally.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const REMIND_EVERY_MS = 30 * 60 * 1000
const MARKER_DIR = path.join('.claude', 'hooks', '.stop-markers')

let input = ''
process.stdin.on('data', (c) => (input += c))
process.stdin.on('end', () => {
  let data
  try {
    data = JSON.parse(input)
  } catch {
    process.exit(0)
  }
  const sessionId = data.session_id
  const cwd = data.cwd
  if (!sessionId || !cwd) process.exit(0)

  let root
  try {
    root = execSync('git rev-parse --show-toplevel', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    process.exit(0)
  }

  const marker = path.join(root, MARKER_DIR, sessionId)
  try {
    const age = Date.now() - fs.statSync(marker).mtimeMs
    if (age < REMIND_EVERY_MS) process.exit(0)
  } catch {
    /* no marker yet — first reminder this session */
  }
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true })
    fs.writeFileSync(marker, '')
  } catch {
    process.exit(0)
  }

  const file = path.join(root, '.agent-context.md')
  if (!fs.existsSync(file)) {
    try {
      fs.writeFileSync(file, `# ${path.basename(root)} — working notes\n`)
    } catch {
      process.exit(0)
    }
  }

  process.stderr.write(
    "Before this turn ends: this repo tracks shared context in `.agent-context.md`. If anything " +
    "from this session is worth a future session knowing, update it now — edit in place, keep it " +
    "tight, don't append a log. Nothing to add? Just say so and finish.\n"
  )
  process.exit(2)
})
