# MemoryAI

> **One brain. Every AI you use. Forever.**

Your AI assistant has no memory. Every session starts from zero — you
re-explain your project, your stack, your preferences. Again and again.
Tomorrow you switch model, switch IDE, and you do it all over.

MemoryAI fixes that.

One memory. Carried from chat to code to research. Survives every
model switch, every IDE, every vendor change. Your knowledge stays
yours.

## Why install

- **It remembers.** Decisions, preferences, the why behind the choices —
  all there the moment you need them.
- **It travels with you.** Same memory in your code editor, your chat
  app, your terminal, your browser. Switch tools, the memory follows.
- **It stays calm.** Long conversations no longer balloon. The window
  is managed quietly so you can keep talking, not keep trimming.
- **It's yours.** You can take everything with you, anytime. No
  lock-in to any single AI vendor.

## Quick start

1. Install **MemoryAI** from the Extensions panel in your IDE.
2. Click **MemoryAI** in the status bar.
3. Paste your key (get one free at <https://memoryai.dev>).

You're done. The status bar shows when memory is active.

## Settings

Open the Connect panel (status bar) or visit IDE Settings → MemoryAI.
The defaults are tuned for typical usage; most users only adjust the
budget.

| Setting | Default | What it controls |
|---|---|---|
| Hard cap | 150,000 | Per-prompt budget |
| Auto-rotate | on | Manage the window automatically |
| Recall depth | deep | Quality vs latency for recall |
| Private mode | off | Local-only for NDA / regulated data |
| Status bar | savings | Status-bar display format |

## Privacy

- Your key lives in the IDE's encrypted secret storage.
- Conversation data leaves the IDE only when MemoryAI needs to persist
  or recall it.
- Turn on **Private mode** to keep everything local.
- Self-host the service — point `memoryai.endpoint` at your own
  deployment.

## Support

- Site: <https://memoryai.dev>
- Issues: <https://github.com/memoryai-dev/memoryai-vsx/issues>

## License

MIT.
