## v2.0.0 — Major fork / rewrite (from upstream v1.4.2)

This repository is a major fork of DashReader (upstream v1.4.2). The plugin has been reworked into a focus-first RSVP reader with a different UI, different navigation model, and a substantially different internal structure. This fork is maintained independently and is not intended as a drop-in upstream contribution.

### What this fork is optimized for
- Fast, low-friction “open → read immediately” RSVP in a dedicated modal
- Strong navigation while reading (seek, headings, rewind/forward by time, word stepping while paused)
- Context visibility that matches what you actually see on screen (line-wrapped context, not fixed word counts)
- Stable timing and time estimates that stay consistent with slow-start / acceleration / micropause behavior

---

## UI & interaction changes (high-level)

### Modal “reading page” with blur
DashReader opens as a dedicated modal overlay, with the reading view isolated from the editor for distraction-free reading.

### Focus band + ORP anchoring
The center row is the RSVP “focus band” with ORP-style anchoring and a visual focus overlay. Long tokens can shrink-to-fit down to a configurable minimum font size.

### Context panels (before/after)
Optional context panels appear above and below the focus band:
- **Line-based**: they display *N visual lines*, using the browser’s actual wrapping at your current window width.
- Auto-updates on resize so context stays accurate.
- While playing, context is intentionally dimmer; while paused it becomes more readable (and you can “peek” via hover).

---

## Navigation (the big difference)

### Tap/click to play/pause (mobile-friendly)
Tap/click the reading area to toggle play/pause. This is designed to make mobile use viable without needing precise button taps.

### Scroll wheel / trackpad while paused = word stepping
When playback is **paused**, scrolling the mouse wheel / trackpad will step through the text **word-by-word** (no playback). This provides “fine scrubbing” without using the progress bar.

### Progress bar seeking (click-to-jump)
The progress bar supports click-to-jump:
- Click anywhere on the bar to jump to that approximate word index.
- If you were playing, playback continues from that point.
- If you were paused, it stays paused (so seeking doesn’t force playback).

### Progress bar hover tooltip = “where you’ll land”
Hovering the progress bar shows a tooltip that includes:
- Current heading path (breadcrumb context)
- Word index (e.g., 1200/5600)
- Virtual-time position (elapsed/total) based on the same timing model used for playback

### Heading navigation (up/down)
You can jump by heading:
- **Previous heading / Next heading** actions jump to adjacent headings.
- Repeating the action quickly cycles headings (useful for moving through the outline rapidly).
- Headings include Obsidian headings and callout “pseudo-headings” (depending on parsing rules).

### Breadcrumb + outline menu navigation
At the top:
- Breadcrumb shows the current hierarchical position (H1 › H2 › H3…).
- An outline button opens a full outline menu for fast jumps.
- A dropdown provides sibling navigation at the current heading level.
- Jumping via breadcrumb/menus respects play/pause state (doesn’t unexpectedly start playback if you were paused).

### Time-based rewind/forward (virtual timeline)
Rewind/forward is **seconds-based** (not “N words”):
- Rewind/forward moves by virtual time and remains consistent even with micropause, slow start, and acceleration.
- Forward behaves like “undo” if you rewound into recorded history, otherwise it seeks forward consistently using the same delay model.

### Jump to start/end
One-tap jump to start and jump to end are available in the on-screen controls.

---

## Timing model updates (accuracy + consistency)
This fork uses a virtual timeline model so:
- Playback timing and time estimates match (no “estimate drift”)
- Micropauses, slow start, and acceleration are accounted for in elapsed/remaining time and progress tooltip time

---

## Settings & profiles
- Separate **desktop vs mobile** profiles (WPM, chunk size, font sizes, context settings)
- Theme-aware colors:
  - highlight/font/background can be set explicitly or left blank to defer to theme/CSS variables
- Micropause is configurable by category (punctuation, paragraph breaks, numbers, section markers, list bullets, callouts)

---

## Not included
- PDF support is not included in this release (planned/possible later).

---

## Compatibility notes
- Settings schema and behavior differ from upstream.
- Internal structure diverges significantly.
- If you used upstream, expect to reconfigure settings after switching to this fork.
