# ChatSlim

Keep giant SillyTavern chats from killing your browser.

## Why this exists

SillyTavern loads and saves each chat as a single unit: every message, every
swipe you never chose, and every scrap of per-message extension metadata is
parsed into one in-memory array, and the whole thing is rewritten on every
save. That's fine at a few hundred messages. It is not fine at a few thousand.

This extension came out of a real chat that hit the wall:

- **2,457 messages, 18.7MB** in a single `.jsonl`
- Of that, only **3.98MB was visible message text**
- **4.15MB** was unchosen swipes, **4.13MB** was per-swipe `swipe_info` metadata,
  and **6.0MB** was `extra` — mostly a summariser extension's chain-of-thought
  scratch text, duplicated again inside every swipe
- Result: minutes-long loads, UI freezes after sending, browser **"Out of
  Memory"** crashes, and eventually a reproducible **STATUS_BREAKPOINT**
  renderer crash the moment a generation started — even in a dedicated
  browser window with hardware acceleration off

Slimming that file to 9.4MB (zero visible changes) and continuing in a
300-message branch (1.5MB) eliminated every crash.

See [SillyTavern#5265](https://github.com/SillyTavern/SillyTavern/issues/5265)
(full-file saves don't scale) and
[SillyTavern#3074](https://github.com/SillyTavern/SillyTavern/issues/3074)
(a 2,500-message chat taking minutes to load). Until chat handling becomes
incremental in core, this extension is the mitigation.

## What it does

1. **Warns you** when the loaded chat passes a size threshold (default 6MB
   in-memory), before the browser starts dying.
2. **Slim this chat** — for every message older than the last *N* (default 60):
   - drops unchosen swipes (the visible message and its own swipe are untouched)
   - drops the per-swipe `swipe_info[].extra` blobs
   - blanks known scratch fields everywhere (`qvink_memory.reasoning`)
3. **Slim & Branch** — slims, then invokes SillyTavern's native `/branch` **and trims the new file to a configurable tail** (default 300 messages — native branches copy the entire history), so
   you continue in a fresh, light file while the original stays complete on disk.

### What it never touches

- Visible message text, names, roles
- The chosen swipe of any message
- Summariser **memories** (only the throwaway *reasoning* scratch is blanked)
- The last *N* messages keep all their swipes

Before every save the visible transcript is verified **byte-identical** to what
was loaded. If verification fails, nothing is written.

## Install

Extensions ▸ Install extension ▸ paste this repository URL.

Or manually: copy this folder to
`data/<user>/extensions/SillyTavern-ChatSlim/` and reload.

## Pairing advice for long-form stories

Slimming buys you headroom; it does not change the architecture. For stories
that run to thousands of messages, the durable pattern is:

- keep durable canon in **World Info / lorebooks** (state, people, timeline)
- run a summariser for rolling memory
- **branch at arc boundaries** and let old files retire

ChatSlim makes that workflow one click instead of a maintenance chore.

## License

MIT
