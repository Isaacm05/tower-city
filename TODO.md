# TODO

## 1. Verify the shared hive actually works across two laptops

Everything in `server/lib/hive-git.mjs` has only ever run on one machine this whole build —
`readTeamAgents`/`writeLocalAgents`/dedup-by-device-id is logic-tested (`test/hive-git.test.mjs`)
but never watched end-to-end with two real machines pushing/pulling through an actual shared
GitHub repo.

To check:
- Clone the same project on a second machine, run Tower City there, let it write its own
  `.hive/agents/<device-id>.json`.
- Commit + push from machine A, pull on machine B (and vice versa) — confirm each machine's
  threads show up as `remote: true` astronauts on the other, with nicknames preserved.
- Confirm a machine never overwrites another's `.hive/agents/<other-device-id>.json` — each
  device should only ever touch its own file.
- Confirm the "only your own threads are actionable" split actually holds on both sides (no
  "find me" highlight, not in the sidebar list, for the other machine's threads).

## 2. Fix the CLI/WaveTerm launch

Built and unit-verified (argv construction, transport dispatch in `present()`/`openInTerminal`),
but not confirmed working end-to-end against a real Wave Terminal window from Tower City's own
dev server process.

Likely culprit, worth checking first: `server/lib/win.mjs`'s Wave path (`tryWave`) needs
`WAVETERM_JWT`/`WAVETERM_TABID` in the process environment. The always-on production launcher
(`bot-crossing.vbs`, for the *original* app) sets these by hand because it starts the server
*detached* from any Wave block. Tower City's dev server (`npm run dev`) doesn't have an
equivalent — if it's started from an actual Wave Terminal tab it should inherit them for free,
but if it's started any other way (a plain terminal, a script, another IDE's integrated
terminal), Wave-targeted launches will fail every time with no obvious explanation on screen.

To check:
- Confirm `echo $env:WAVETERM_JWT` / `echo $env:WAVETERM_TABID` are actually set in whatever
  shell `npm run dev` is run from.
- If not, either document "run `npm run dev` from inside Wave Terminal" as a real requirement,
  or give Tower City's own dev/serve scripts the same env-var workaround `bot-crossing.vbs` uses.
- Also worth a plain sanity check independent of the above: does "Terminal" (skip-Wave) work
  correctly on its own? If that also fails, the bug is elsewhere (`cliBinary()` not resolving,
  or a bad `cwd`), not the Wave-specific path.
