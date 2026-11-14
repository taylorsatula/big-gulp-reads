# big-gulp-reads

A [pi](https://pi.dev) package that replaces the built-in `read` tool with one whose truncation limit you control. The built-in caps file reads at **50KB / 2000 lines** with constants no setting can change; big-gulp-reads raises that to **200KB / 5000 lines** by default and lets you change it at any time without restarting.

## Install

```
pi install npm:big-gulp-reads
```

New sessions pick it up automatically — the extension registers a tool named `read` that replaces the built-in. The `offset`/`limit` parameters, continuation notices, and image attachments all work exactly as before.

## Usage

| Command | Effect |
|---|---|
| `/big-gulp-reads` | Show current limits |
| `/big-gulp-reads 400` | Set the byte cap to 400KB |
| `/big-gulp-reads lines 10000` | Set the line cap to 10000 |
| `/big-gulp-reads reset` | Back to defaults (200KB / 5000 lines) |

Limits persist across sessions in `~/.pi/agent/big-gulp-reads.json` and apply to the current session immediately.

## Caveats

- **Watch your context window.** A full 131k-token context is only ~650KB of prose, so a couple of unbounded reads can consume it — pick a limit that fits your model.
- **Images are not auto-resized.** pi does not export its image-resize helper, so image reads are sent as attachments at full size; providers with image dimension caps may reject very large images.
