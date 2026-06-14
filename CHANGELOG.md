# Changelog

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
