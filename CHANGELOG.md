# Changelog

## 0.1.9

- New percent-based thresholds — `memoryai.compactPct` (default 0.30) and
  `memoryai.criticalPct` (default 0.50). Sent to the MCP server as
  `HM_COMPACT_PCT` / `HM_CRITICAL_PCT` env vars and as `compact_pct` /
  `critical_pct` on guard requests. Adapts automatically to any model's
  context window (Sonnet 200K, Opus 1M) instead of hard-coding token
  counts. Absolute `compactAtTokens` / `criticalAtTokens` stay as fallback.
- Brain identity in the status bar tooltip — when `/v1/stats` returns
  `brain_name`, `brain_age_days`, `last_dream_at`, or `dna_count`, the
  tooltip shows `Brain "Mnemo" · 47d old`, `DNA-protected: 12`,
  `Last dream: 3h ago`. Older servers fall back to the original layout.
- Hardening: `JSON.parse` is now wrapped, an extension-state handler leak
  on disconnect/connect is fixed, and the status bar no longer flips to
  `connected` before the first `/v1/stats` reply lands.

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
