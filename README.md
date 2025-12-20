# DashReader

[![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)](https://github.com/inattendu/dashreader)
[![Obsidian](https://img.shields.io/badge/Obsidian-Compatible-8b5cf6.svg)](https://obsidian.md)
[![Status](https://img.shields.io/badge/status-stable-green.svg)](https://github.com/inattendu/dashreader)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

# DashReader (Fork)

![DashReader Demo](New DashReader.gif)

This repository is a major fork of the upstream DashReader project (original: `inattendu/dashreader`).  
It diverges heavily in UI, navigation behavior, and internal structure.

If you’re looking for the upstream plugin, use the original repo. If you want the “focus-first RSVP modal reader” with strong navigation, use this fork.

---

## What DashReader does

DashReader is an RSVP (Rapid Serial Visual Presentation) speed-reader for Obsidian.

Instead of scanning lines, DashReader shows a **focus band** (center row) and presents text in **word chunks** at a controlled speed (WPM). This fork emphasizes:

- A distraction-free modal “reading page”
- Reliable navigation (seek, headings, time-based rewind/forward)
- Context windows that match what you *actually see* on screen (line-wrapped context)
- Timing consistency: time estimates and playback share the same model

---

## UI overview (this fork)

DashReader opens as a modal overlay with a blurred backdrop (theme-dependent).

**Top**
- Breadcrumb navigation showing your current heading path
- Outline / dropdown menus for heading jumps

**Middle**
- The RSVP focus band with ORP anchoring + focus overlay lines
- Headings/callouts display with separators (when encountered)

**Context**
- Optional context panels:
  - “Before” context above the focus band
  - “After” context below the focus band
- Context is **line-based** and uses your window’s real wrapping

**Bottom**
- Progress bar (seekable)
- Progress info (index + time)
- On-screen navigation buttons (mobile-friendly)

---

## Navigation & interaction (important)

### 1) Tap/click the reading area = play/pause
- Tap/click on the reading area toggles playback.
- Designed for mobile first: you don’t need precise button taps.

### 2) Scroll wheel / trackpad while paused = step words
When playback is **paused**, scrolling steps through text **word-by-word**.
- Scroll down: step forward
- Scroll up: step backward
This is for precise “scrubbing” without starting playback.

### 3) Progress bar click-to-seek
Click anywhere on the progress bar to jump to that point in the text.
- If you were playing, playback continues from the new position.
- If you were paused, it stays paused (seeking won’t force playback).

### 4) Progress bar hover tooltip (“where am I / where will I land?”)
Hovering the progress bar shows:
- Current heading path
- Word position (e.g., 1200/5600)
- Virtual-time position (elapsed/total), using the same timing model as playback

### 5) Heading navigation (previous/next heading)
DashReader supports heading jumps:
- Previous heading / Next heading actions jump across headings
- Repeating the action quickly cycles headings (useful for scanning structure)
- Callouts can be treated as “pseudo-headings” (depending on parsing rules)

### 6) Breadcrumb + outline menu navigation
- Breadcrumb shows hierarchical path (H1 › H2 › H3…)
- Outline menu shows the document structure for quick jumps
- Dropdown menu supports sibling navigation
- Jumping via these menus respects your play/pause state (no unexpected autoplay)

### 7) Time-based rewind/forward (virtual timeline)
Rewind/forward actions move by **seconds**, not word counts.
This fork uses a virtual timeline so rewind/forward remains consistent even when:
- micropauses are enabled
- slow start / acceleration are enabled
- you seek using the progress bar

### 8) Jump to start/end
On-screen controls include jump-to-start and jump-to-end actions.

---

## Timing model (why time feels consistent here)

DashReader’s playback and time estimates use a **virtual timeline**:
- The same rules used to delay words during playback are also used to compute elapsed/total times
- This keeps progress/time/rewind/forward consistent with:
  - micropauses
  - slow-start
  - acceleration

---

## Settings (high level)

This fork includes separate desktop/mobile profiles where relevant.

### Reading
- Words per minute (WPM)
- Words at a time (chunk size)
- Auto-start + delay (optional)

### Display
- Font size (desktop + mobile)
- Minimum token font size (for shrink-to-fit on long tokens)
- Font family

### Context
- Show/hide context per profile
- Context lines (desktop + mobile)
- Context font size (desktop + mobile)

### Navigation UI
- Show breadcrumb
- Show progress bar

### Appearance
- Highlight color
- Font color
- Background color  
You can leave these blank to defer to theme/CSS variables.

### Micropause
Micropause can be toggled and tuned by category, for example:
- sentence-ending punctuation
- other punctuation
- long words
- paragraph breaks
- numbers
- section markers
- list bullets
- callouts

---

## Keyboard shortcuts (inside the DashReader modal)

These apply when the DashReader modal is open and no input field is focused.

### Playback / navigation
- `Space`: Play/Pause
- `←`: Rewind **10 seconds**
- `→`: Forward **10 seconds**
- `Ctrl/Cmd + ←`: Jump to start
- `Ctrl/Cmd + →`: Jump to end
- `↑`: Previous heading
- `↓`: Next heading
- `Esc`: Stop/quit reading

### Panels
- `s`: Toggle the inline controls/settings panel (opens/closes the bottom inline panel)

---

## How to open DashReader
Common entry points:
- Ribbon icon
- Command palette
- Editor context menu (“Read with speed reader”) when text is selected

DashReader will load from the active markdown note and can start from your selection/cursor depending on how you invoke it.

---

## Install
This fork is not published as an Obsidian Community Plugin release.

Install options:
- Manual install (copy the built plugin into `.obsidian/plugins/`)
- BRAT (if you use it)

---

## Fork relationship
- Upstream: `inattendu/dashreader`
- This fork: `MiserMagus/dashreader`

This fork prioritizes a different reading workflow and is not intended to remain API-compatible with upstream.

---

## License
MIT (inherit upstream license; see LICENSE)
