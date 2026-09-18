# tools/

## `bin/wsh-patched.exe` (not checked in)

A locally-built copy of Wave Terminal's `wsh` CLI with two extra flags on `wsh run` —
`--target <blockid>` and `--split <right|down|left|up>` — that let `server/lib/win.mjs` place a
new terminal block exactly where the colony's stacking policy wants it, instead of wherever Wave
Terminal's own tiling picks. The stock `wsh` has no such flags; the underlying RPC does
(`CommandCreateBlockData.TargetBlockId`/`TargetAction` in `pkg/wshrpc/wshrpctypes.go`), it's just
never wired up to the CLI.

`server/lib/win.mjs` looks for this binary first and falls back to plain `wsh.exe` on PATH if
it's missing — so a checkout without it still works, just without deliberate placement.

### Rebuilding it

Needs Go (`winget install GoLang.Go`) and must be built against the **same version tag** as the
Wave Terminal actually installed (`wsh.exe version` on this machine, or `wsh-patched.exe version`
— that one's a placeholder `v0.0.0` since the real build injects it via ldflags, so go by the git
tag you checked out instead). Building against a mismatched version risks an RPC schema drift
that only shows up as a mysterious failure at runtime.

```sh
git clone --depth 1 https://github.com/wavetermdev/waveterm.git wsh-patched
cd wsh-patched
git fetch --depth 1 origin tag v0.14.5   # match your installed Wave Terminal's version
git checkout v0.14.5
git apply /path/to/bot-crossing/tools/wsh-run-target-split.patch
go build -o wsh-patched.exe ./cmd/wsh
```

Then copy the result to `tools/bin/wsh-patched.exe` here.

### If this should really be upstream instead

The patch is small (~15 lines) and mirrors what `wshcmd-web.go`'s `--replace` flag already does
for the "replace" action, just extended to the four split directions. Their repo has
`.kilocode/skills/add-wshcmd/SKILL.md` as a contributor guide for this exact kind of change, in
case it's ever worth submitting for real instead of carrying a local patch indefinitely.
