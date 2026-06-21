# Changelog

## 0.5.0 — Percent-native context guard + live Kiro usage watch (2026-06-21)

- **Context Guard rebuilt around real fill %.** On Kiro the extension now reads
  Kiro's own `contextUsagePercentage` from the active session file and compares
  it directly against the configured thresholds — no more turn-count
  estimation or guessed token windows. A new background `ContextMonitor` polls
  the active session every 8s, selects the truly-active session (active flag →
  activeTabId → highest usage → newest mtime), and acts on the exact number
  Kiro shows in its UI.
- **Two percent thresholds, one knob.** `criticalPercent` (force save + the
  single "context is full" notice) drives everything; the soft `compact` point
  where silent saving begins is derived automatically at 85% of it. Cross
  compact → the conversation tail is saved silently to the brain; cross
  critical → save (if not already) + raise the notice once per episode.
  Dropping back below compact re-arms for the next climb, and a new session id
  resets cleanly.
- **Settings collapsed to two fields.** `memoryai.contextWindow` (200000 /
  1000000 / any exact number) and `memoryai.criticalPercent` (0 = auto-follow
  the window: ≤200K → 95, >200K → 30; or 5–99 to override). Removed
  `memoryai.compactMode`, `memoryai.model`, and `memoryai.compactAtTokens`
  along with the brittle model-name → window guesser. The Connect panel
  auto-snaps the critical % when you switch window and shows the derived
  compact point live.
- **No double notices.** On Kiro the local monitor owns the notice, so the
  server-snapshot pressure bridge is skipped there; Cursor / Windsurf / VS Code
  keep using the existing `/v1/stats` pressure path.

## 0.4.3 — Reliable "context full" notice (2026-06-20)

- The critical "context is full — run /compact or open a new chat" notice no
  longer depends on the model echoing an `action_prompt`. When the model's
  turn-check reports critical pressure, the server records it and the extension
  surfaces it through real IDE UI off its existing 60s `/v1/stats` poll:
  a `showWarningMessage` modal (once per pressure episode) plus a persistent
  warning status-bar item that stays until pressure subsides. The model cannot
  suppress either.
- Silent-save policy unchanged: `compact_soon`/`safe` stay silent; only
  `compact_now`/`spawn_now` raise the notice.
- Claude Code is unaffected — it auto-compacts and runs no extension, so it
  never shows this notice (by design). Bare-MCP hosts keep the previous
  best-effort `action_prompt` fallback.
- Server-side: new in-memory per-tenant pressure ledger (TTL 10m), exposed as
  an optional `context_pressure` field on `/v1/stats`. Older clients ignore it;
  older servers omit it (read null-safe).

## 0.4.2 — Shared GuardSettings type (2026-06-19)

- Depend on `@memoryai.dev/core@^1.1.0` for the `GuardSettings` type only
  (`import type`, fully erased by esbuild). The Context Guard settings shape is
  now owned by core as the single source of truth shared with claude-cli and
  the MCP server, so the three clients can't drift apart on its fields. No
  runtime code from core is bundled — the extension still ships as a pure-JS
  bundle with no native binary.

## 0.4.1 — Pure-JS bundle (2026-06-18)

- **Removed the native dependency.** The extension no longer declares
  `@memoryai.dev/core` or `better-sqlite3` (neither was imported — the
  extension talks to the server directly over `fetch`). esbuild no longer
  externals `better-sqlite3` and `.vscodeignore` drops the native re-includes.
- **VSIX size: ~3.7MB → <0.1MB** (no native binary shipped).
- Status-bar `User-Agent` now reports the real extension version instead of a
  hardcoded string.
- Fixed three "Open Output" actions that called an unregistered
  `memoryai.logs` command; they now call `memoryai.exportLogs`.

## 0.3.0 — Perfect VSX (2025-01-XX)

**8 critical fixes + performance improvements from 20-agent deep code review.**

### Security & Privacy (P0)
- **Logger redaction**: API keys (`hm_sk_*`), Bearer tokens, and Authorization headers now masked before logging to Output channel and export files. Closes privacy leak.
- **Webview input validation**: postMessage payload strict type guards (endpoint, compactAtTokens, compactMode). URL whitelist for openExternal (https://memoryai.dev/* only). Prevents type confusion and unauthorized external links.

### Reliability (P1)
- **Wire fail visibility**: Re-wire on activation errors now show UI warning with "Open Output" button instead of silent fail. User can troubleshoot config drift (permission denied, etc).
- **Rules template dynamic args**: Inherited from 0.2.5 — buildGuardLine() now passes connect inputs (model, compactAtTokens) into Kiro hook + Cursor/Windsurf rules, so `ide_turn_check` gets the user's actual thresholds instead of hardcoded 200K.
- **Disconnect atomic rollback**: Unwire runs BEFORE deleting API key. If unwire fails (permission error), disconnect aborts and key stays intact. Prevents zombie state (API key gone, MCP config orphaned).

### Performance (P2)
- **StatusBar throttle**: `update()` debounced 500ms to prevent UI thrash on burst updates. State changes (connected/disconnected) still immediate.
- **Save mode feedback**: ConnectPanel shows "compact at X, critical at Y" confirmation when saving manual mode, "auto mode" for auto. User visibility into what's being saved.

### Breaking Changes
None — all fixes backward-compatible.

## 0.2.5

- Pass connect inputs (endpoint / api key / model) into the Kiro recall hook
  + Cursor / Windsurf rules so the prompts can reference the user's actual
  model when the agent calls `ide_turn_check`. Same wiring already used by
  the MCP env block; this aligns the hook/rules path with it.

## 0.2.4

- Packaging/version sync release for the manual-mode threshold work
  (0.2.3 line). No behaviour change beyond 0.2.3 — ensures the published
  build, the canonical repo, and both marketplaces all carry the same
  version.

## 0.2.3

- Manual mode now asks for the **compact** point instead of the critical
  ceiling. You set "Compact At Tokens" (the soft point where saving starts)
  and the hard critical ceiling is derived automatically at 1.2× of it.
  Reasoning: the compact point is the number users actually think about
  ("save around here"); the ceiling is just a safety margin above it.
  Example: set 160000 → critical at 192000. Replaces the 0.2.2 model where
  you set critical and compact was derived at 80%.

## 0.2.2

- Manual mode is now a single number. Removed the "Compact At Tokens" setting
  — you only set "Critical At Tokens" (the hard ceiling where a compact is
  forced) and the soft compact warning is derived automatically at 80% of it.
  One number to reason about instead of two, and no risk of setting an
  invalid compact ≥ critical pair.

## 0.2.1

- Settings polish: the context-guard fields now carry an explicit `order` so
  Compact Mode, Model, Compact At Tokens, and Critical At Tokens sit together
  in the right sequence (VS Code was alphabetising them, which split the two
  token fields apart).
- Clearer descriptions: each field now states whether it applies in auto or
  manual mode. Note: VS Code's native Settings page cannot hide a field based
  on another field's value, so every field is always visible there — the
  MemoryAI Connect panel is the place that hides auto/manual fields for you.

## 0.2.0

- Ships the manual context-guard threshold settings that were authored but
  never packaged into a published build. `memoryai.compactMode`,
  `memoryai.compactAtTokens`, and `memoryai.criticalAtTokens` are now visible
  in Settings and wired end-to-end through the MCP env
  (`MEMORYAI_COMPACT_AT` / `MEMORYAI_CRITICAL_AT`) to the server. No server
  change required — the server already honours these overrides.
- Minor bump from 0.1.x to 0.2.0 because the published 0.1.14 did not actually
  contain the 0.1.13 manual-mode work.

## 0.1.14

- Context Guard is now silent-all except the single "context is full" notice.
  Every save (compact_soon and compact_now) runs invisibly; the only message
  you ever see is the one-per-session notice when the window is actually full
  and you need to /compact or start a new chat. No more mid-task chatter.

## 0.1.13

- Context Guard now has two modes, set via `memoryai.compactMode`:
  - **auto** (default) — set `memoryai.model` and the server detects the
    context window and picks the trigger automatically (≤200K → 95%,
    >200K → 30%).
  - **manual** — set `memoryai.compactAtTokens` and
    `memoryai.criticalAtTokens` to exact token counts and the guard fires
    at those regardless of model. E.g. on a 1M-window model: 150000/200000,
    or 500000/600000. Forwarded to the MCP server as `MEMORYAI_COMPACT_AT` /
    `MEMORYAI_CRITICAL_AT`.
- The Connect panel surfaces both modes with a model field (auto) or two
  token fields (manual), validates compact < critical, and re-wires the MCP
  env immediately on save.
- Added Claude 4.8 family to the server model catalog
  (`claude-opus-4-8`, `claude-sonnet-4-8`, plus `[1m]` variants).

## 0.1.12

- Fix: a new Kiro chat now restores context automatically. Kiro has no
  SessionStart event, so the bootstrap relied on a hook that wasn't being
  installed — a fresh chat started blank, breaking the "start a new chat,
  I'll restore everything" promise of the save-then-notify guard. Added
  `memoryai-recall.kiro.hook` (promptSubmit, gated to the first turn) that
  calls memory_bootstrap once and recalls on past-work references. Claude
  Code (SessionStart runner) and Cursor/Windsurf (rules files) already did
  this; Kiro was the gap.

## 0.1.11

- Context guard is now save-then-notify (was silent). When the window is full,
  the agent saves your full context to the brain first, then shows ONE short
  line telling you to start a new chat / `/compact` to shrink the window — it
  restores everything automatically. This is the only path that genuinely
  reduces the context window, so it is now visible instead of hidden.
- The guard hook forwards your configured `memoryai.model` so the right
  window-adaptive trigger applies (≤200K → 95%, >200K → 30%).

## 0.1.10

- New `memoryai.model` setting — tell MemoryAI your model name and the
  context guard auto-detects its window to pick the right compact trigger:
  windows ≤200K (Claude/GPT/Sonnet) compact at 95%, windows >200K
  (1M Opus / Gemini) compact at 30%. Forwarded to the MCP server as
  `MEMORYAI_MODEL`. Leave blank for the 200K default.

## 0.1.9

- Percent-based thresholds + brain identity in the status-bar tooltip.

## 0.1.8

- Status bar now shows the full picture by default: total memories ·
  stores↑ recalls↓ this month · $ saved today. Every number is a real
  measurement from `/v1/stats` — no faked progress.
- New display modes: `full` (default), `tokens` repurposed as brain volume,
  `compact` repurposed as monthly activity. `savings` and `off` unchanged.

## 0.1.7

- New tagline: "One brain. Every AI you use. Forever." Description now leads
  with the multi-IDE shared-memory positioning.

## 0.1.6

- Repository moved to `github.com/memoryai-dev/memoryai-vsx` as the canonical
  source. No behaviour changes.

## 0.1.1

- The extension now wires every host file end-to-end on Connect: MCP config,
  Kiro Agent Hooks (auto-recall + auto-capture), Cursor rules, Windsurf rules.
  Memory becomes active from the next message with no manual config.
- Disconnect cleanly removes only the entries we created. Foreign content is
  always preserved.
- Wiring re-runs on every IDE start so config drift heals itself.

## 0.1.0

Initial release.

- Persistent memory across IDE sessions.
- Per-prompt token budget with auto-managed conversation window.
- Connect panel with logo, key field, and most-touched settings.
- Status bar indicator showing daily savings.
- Works across VS Code-based IDEs out of the box.
- Private mode for NDA / regulated workloads.
- Self-hosted endpoint supported.
