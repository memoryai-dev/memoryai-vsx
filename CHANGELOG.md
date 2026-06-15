# Changelog

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
