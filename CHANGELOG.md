# Changelog

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
