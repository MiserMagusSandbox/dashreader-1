# PDF selection anchoring: fit-for-purpose review

## Does the current approach satisfy "launch exactly where I double-click"?

* **Token-space alignment:** `findStartWordIndexFromSelection` re-tokenizes the PDF text using the same RSVP engine rules, then biases matches toward the caller-provided preferred index rather than the first duplicate elsewhere. Single-token selections now cap how far a one-character click can drift, so superscripts and single letters stay anchored to the clicked spot.【F:src/pdf-view-integration.ts†L2339-L2456】
* **Probe-assisted anchoring:** When the selection contains multiple tokens, `alignStartWordIndexToSelection` scores nearby candidates using a probe that is trimmed to start at the selection (skipping punctuation-only glue), falling back to a full sweep only if the local window fails. This preserves the exact visual start while still recovering from skewed hints.【F:src/pdf-view-integration.ts†L2458-L2542】
* **Normalization safeguards:** Selection normalization keeps punctuation and biomedical marker chains intact, inserting whitespace only where necessary so that partial clicks within `CD11b+CD14-…` remain matchable without changing token order.【F:src/pdf-parser.ts†L44-L73】【F:src/pdf-parser.ts†L85-L137】
* **Geometry-aware fallback:** When PDF.js page ordering is scrambled (e.g., unusual multi-column layouts), per-page anchoring now applies a geometry-based distance cap so mis-clustered duplicates outside the selection’s y-band are ignored instead of hijacking the launch point.【F:src/pdf-view-integration.ts†L2584-L2681】

## Strengths

1. **Duplicate-resistant anchoring:** Preferred indices and probe scoring make repeated acronyms or markers resolve to the selected instance instead of the first occurrence, directly addressing prior drift complaints.【F:src/pdf-view-integration.ts†L2339-L2456】【F:src/pdf-view-integration.ts†L2458-L2542】
2. **Chain-friendly tokenization:** Biomedical separators (+/−/–/slash) are normalized before tokenization, which lets double-clicks on any segment of dense marker chains start the reader reliably.【F:src/pdf-parser.ts†L44-L73】【F:src/pdf-parser.ts†L109-L137】
3. **Whitespace and glyph cleanup:** Private-use glyph repairs and glued-bracket spacing prevent invisible characters from splitting or merging tokens, reducing chances of misaligned selections.【F:src/pdf-parser.ts†L85-L115】【F:src/pdf-parser.ts†L119-L137】

## Gaps / risks addressed

1. **Ambiguous single-letter clicks:** Single-character matches are now capped to a small distance around the preferred hint, preventing far-away matches from hijacking superscript clicks while still falling back if no near match exists.【F:src/pdf-view-integration.ts†L2376-L2417】
2. **Geometry fallback for multi-column gaps:** Per-page matching enforces a y-band distance limit derived from the selection rectangle, so tokens in other columns or header/footer regions can’t steal the anchor when DOM hints are wrong.【F:src/pdf-view-integration.ts†L2584-L2681】
3. **Probe trimming for nested punctuation:** Probe trimming now skips leading punctuation-only tokens before aligning, keeping anchors on the intended word inside nested parentheses or dash glue.【F:src/pdf-view-integration.ts†L2303-L2336】
4. **Acronym disambiguation beyond distance:** Ambiguous all-caps selections now require surrounding context agreement; candidates without matching neighbors are discarded so `(ADP)-ribose` anchors to the clicked parenthetical form instead of drifting to the next `ADP-ribose`.【F:src/pdf-view-integration.ts†L2597-L2704】

## Recommendation

The current logic is fit for purpose for the stated goal—launching from exactly where the user double-clicks—because it reuses engine tokenization, prefers the clicked occurrence, honors biomedical chains, and now clamps the remaining drift cases with geometry- and distance-aware guards.
