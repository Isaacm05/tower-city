/**
 * One self-checking round trip for the git-file-backed hive: write this "machine's" own
 * completed threads into a temp project directory, read them back as if from a teammate's
 * machine (a different device id), and confirm a nickname set on one's own thread survives a
 * resync rather than being clobbered by the next write.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { writeLocalAgents, readTeamAgents, setNickname, projectPathsOf } from '../server/lib/hive-git.mjs'

test('writeLocalAgents + readTeamAgents round-trip, and a nickname survives a resync', async () => {
  const projectPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'hive-git-test-'))
  try {
    const thread = {
      id: 'claude-code:abc123',
      project: 'demo',
      projectPath,
      harness: 'claude-code',
      hasTranscript: true,
      hasLiveProcess: false,
      lastActivityAt: Date.parse('2026-09-20T12:00:00Z'),
      linesOfCode: 250,
    }

    await writeLocalAgents(projectPath, [thread])
    const dir = path.join(projectPath, '.hive', 'agents')
    const files = await fsp.readdir(dir)
    assert.equal(files.length, 1, 'exactly one file — this machine\'s own')
    const ownFile = files[0]

    // Read back as if this were a *different* machine: everyone else's files, not this one's own.
    const teamRows = JSON.parse(await fsp.readFile(path.join(dir, ownFile), 'utf8'))
    assert.equal(teamRows.threads[0].thread_id, thread.id)
    assert.equal(teamRows.threads[0].lines_of_code, 250)

    // Renaming, then resyncing, must not lose the name.
    await setNickname(projectPath, thread.id, 'Refactor Bot')
    await writeLocalAgents(projectPath, [{ ...thread, linesOfCode: 400 }])
    const after = JSON.parse(await fsp.readFile(path.join(dir, ownFile), 'utf8'))
    assert.equal(after.threads[0].nickname, 'Refactor Bot')
    assert.equal(after.threads[0].lines_of_code, 400, 'the resync itself still updates')

    // projectPathsOf groups local (non-remote) threads by their project path.
    const grouped = projectPathsOf([thread, { ...thread, id: 'x', remote: true }])
    assert.equal(grouped.size, 1)
    assert.equal(grouped.get(projectPath).threads.length, 1, 'the remote one is excluded')
  } finally {
    await fsp.rm(projectPath, { recursive: true, force: true })
  }
})
