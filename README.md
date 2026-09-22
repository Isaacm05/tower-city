# Tower City — a shared skyline, grown out of your team's agent threads

A fork of **[Bot Crossing](https://github.com/jarrenrocks/bot-crossing)**, with a different
question in mind. Bot Crossing draws every coding-agent thread on *your* machine as a colony —
one astronaut per session, one building per repo. Tower City is for a team on one shared
project: everyone's completed threads count toward the same skyline, synced through the repo
you already share on GitHub — no server, no account, no database.

Every teammate's local Claude Code / Codex sessions add lines of code to the same city. Towers
grow, more astronauts show up wandering the deck, and the project's shared notes
(`.agent-context.md`) live right there in the sidebar as a slide-out drawer instead of a
separate wiki nobody opens.

> **Status:** a personal/team project, published as-is. Built on top of Bot Crossing's rendering
> engine, camera, asset pipeline and harness-adapter system — all of that credit belongs to
> [Jarren Rocks](https://jarren.rocks) and is unchanged here. See [Licence](#licence) below.

## Run it

```bash
npm install && npm run dev
```

Open `http://localhost:5173/tower-city.html` (or whatever port Vite prints) — that's the shared
skyline view. `index.html` is still the original multi-project colony map, untouched, if you want
it too.

Needs **Node 22.13+** (a couple of things — Codex's session titles, the Antigravity harness —
degrade gracefully but silently on older Node; `/api/harnesses` says exactly why if something's
missing). `npm test` runs the suite.

For a built version: `npm run build` then `npm run serve` (or `npm start` to do both). Binds to
`127.0.0.1` by default — see [Keeping it local](#keeping-it-local) in the sections below,
inherited unchanged from Bot Crossing.

## What's actually different from Bot Crossing

- **One project on screen, sized by lines of code.** Not a map of every repo you've touched —
  one team's project, growing as a skyline. A tower's height reflects a rough,
  line-count-out-of-tool-calls estimate of how much code the team has actually written, not
  transcript size.
- **Shared through git, not a server.** Each teammate's machine writes its own
  `.hive/agents/<device-id>.json` into the repo's working tree — one file per machine, so
  nothing ever merge-conflicts. Nothing is pushed automatically; committing and pushing those
  files is your own normal git workflow, same as any other change. No Supabase, no account, no
  network calls this app makes on its own.
- **Shared project context, front and center.** `.agent-context.md` gets its own slide-out
  drawer (rendered markdown, not a raw text dump), a "Set up shared hive" button that provisions
  a project-level Stop hook so *every* teammate's session gets nudged to keep it updated, and the
  same nudge built for Antigravity's own differently-shaped hook system too.
- **Only your own threads are actionable.** A teammate's completed thread still shows up as an
  astronaut walking the deck, but it's not in your sidebar's thread list and doesn't get the
  "find me" highlight — this is about the shared build, not surveillance of who did what.
- **Antigravity support**, alongside Claude Code, Codex and Cursor — reading real conversations
  from `~/.gemini/antigravity` and `~/.gemini/antigravity-cli`, resuming them via the real `agy
  --conversation <id>` CLI flag. Needs Node 22.13+ for `node:sqlite`.

Everything else — the rendering engine, the camera, the crew, the planets, the harness-adapter
architecture, the whole "how this actually works" story — is Bot Crossing's, and its own
[README](https://github.com/jarrenrocks/bot-crossing#readme) is still the right place to read
about it in depth.

## Which harnesses work

| Harness | Status |
| --- | --- |
| **[Claude Code](https://claude.com/claude-code)** (Anthropic) | ✅ Desktop app and CLI |
| **[Codex](https://developers.openai.com/codex/cli)** (OpenAI) | ✅ Desktop, VS Code and CLI |
| **[Cursor](https://cursor.com)** (Anysphere) | ✅ Agent transcripts |
| **[Antigravity](https://antigravity.google)** (Google) | ✅ Desktop IDE and `agy` CLI — needs Node 22.13+ |

Adding another is one new file in `server/harnesses/` and one line in its `index.mjs` — the
interface, thread shape and ground rules are written down in
[`server/harnesses/README.md`](server/harnesses/README.md).

## Layout

```
server/
  harnesses/         one adapter per agent harness (Claude Code, Codex, Cursor, Antigravity)
  lib/
    hive-git.mjs       the git-file shared-hive sync — read/write, never commits or pushes
    project-setup.mjs  provisions .agent-context.md + the Claude Code and Antigravity Stop hooks
    loc-counter.mjs    lines-of-code-out-of-tool-calls estimate per thread
  api.mjs, scan.mjs, serve.mjs   inherited from Bot Crossing, mostly unchanged
src/
  towers/            Tower City itself — the skyline, the boot script, the sidebar adaptation
  core/, world/, agents/, ui/, game/    Bot Crossing's engine, reused read-only throughout
```

`.agent-context.md` in this repo's own root has the fuller build history if you want the
"why," including every real bug hit along the way.

## Licence

[MIT](LICENSE) — same as Bot Crossing, and it stays that way for anything genuinely new here
too. The original copyright notice in [LICENSE](LICENSE) covers the large majority of this
codebase (the render engine, camera, world, crew) and is preserved as MIT requires.

The project name "Bot Crossing" and the crew's character design are reserved separately from
the MIT grant — see [TRADEMARKS.md](TRADEMARKS.md), inherited from the original and still
accurate here: this fork uses a different name and doesn't touch the character design, so
nothing in it applies any differently to Tower City than it would to any other fork.

The art is CC0 by [Kay Lousberg](https://kaylousberg.com) and [Kenney](https://kenney.nl) — see
the original README's [Where the art comes from](https://github.com/jarrenrocks/bot-crossing#where-the-art-comes-from)
section for full credits.

Not affiliated with Anthropic, OpenAI, Google, Cursor, or Bot Crossing's own author.
