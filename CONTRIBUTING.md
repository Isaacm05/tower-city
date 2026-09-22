# Contributing

Tower City is a fork of [Bot Crossing](https://github.com/jarrenrocks/bot-crossing) — its own
[CONTRIBUTING.md](https://github.com/jarrenrocks/bot-crossing/blob/main/CONTRIBUTING.md) still
applies to anything that belongs upstream (a new harness adapter, a rendering fix, anything
that isn't specific to the shared-team/git-sync model this fork adds).

For anything specific to Tower City itself — the git-file hive sync, the shared context drawer,
the project-setup provisioning — same basic shape as any small open-source project:

- **Issues and PRs are welcome.** No promises on response time.
- **A PR here is a starting point, not a guarantee of merge-as-is** — expect it to get tested,
  possibly adapted, before it lands.
- **Say what you verified and on what machine.** The test suite doesn't cover much; a clear
  description of what you actually ran is worth more than a clean diff.
- **Nothing is ever written to a harness's own files** — `data/`, `.hive/`, and
  `.agent-context.md` are the only things this project writes, same rule Bot Crossing holds.

## Working on it

```bash
npm install && npm run dev
```

`npm test` runs the suite. `npm run assets` re-packs the source art into the `.glb` files the
app loads — a no-op on a fresh clone, since the built files are checked in.

## Licensing

By contributing you agree your work is under the MIT licence, same as the rest of the code.
