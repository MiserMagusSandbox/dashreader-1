# PDF → RSVP Behaviour Specification

This document defines the **normative behaviour** of the PDF parsing and RSVP pipeline.

All implementation decisions **must conform** to these rules. The rules describe **what the system must do**, not how it should be implemented.

---

## 1. Scope of Processing

### 1.1 Narrative Text Only
The system processes **narrative reading text only**.

Narrative text includes:
- Abstract
- Introduction / Background
- Main body sections (e.g. Methods, Results, Discussion, Conclusions)
- Paragraph prose
- Headings
- Lists
- Figure captions
- Table captions
- Inline equations

The following content must **never** enter RSVP:
- Display / block equations
- Table cell contents
- Figure internal text (including SVG overlays, labels, or embedded glyphs)
- Decorative, repeated, or marginal text

---

## 2. Page Structure Rules

### 2.1 Column Awareness (Mandatory)
Each page must be treated as a set of **explicit columns**.

Rules:
- Text belongs to **exactly one column**.
- Reading order is **top-to-bottom within a column**.
- Text does **not cross columns** unless the user selection explicitly crosses a column boundary.
- RSVP stepping must remain within the current column.

Columns must be inferred from layout. Fallback to single-column only when no column structure exists.

---

### 2.2 Margins, Headers, and Footers
The following must be excluded entirely:
- Page headers
- Page footers
- Page numbers
- Running titles
- Marginal notes
- Watermarks

Detection must be **structural** (position, repetition, layout), not vocabulary-based.

---

## 3. Block Classification Rules

Each text fragment must be classified as **exactly one** of the following:

- Paragraph
- Heading
- List item
- Figure caption
- Table caption
- Inline equation
- Display equation (excluded)
- Figure internal (excluded)
- Table internal (excluded)
- Header/Footer (excluded)
- Margin/Decorative (excluded)

Classification must be based on **layout and structure**, not content-specific word lists.

---

## 4. Equations

### 4.1 Inline Equations
Inline equations are treated as normal text and remain in RSVP.

### 4.2 Display Equations
Display equations must be **completely excluded**:
- No tokens
- No anchors
- No RSVP stepping

Detection is based on block-level layout (centering, isolation, spacing), not symbol lists.

---

## 5. Figures

### 5.1 Figure Internals
All text that is part of a figure body is excluded, including:
- SVG labels
- Overlaid text
- Embedded glyph runs
- Axis labels

### 5.2 Figure Captions
Figure captions are included and treated as narrative text.

Captions must be detected **structurally** (position relative to the figure region).

---

## 6. Tables

### 6.1 Table Internals
Table cell contents are excluded.

### 6.2 Table Captions
Table captions are included.

---

## 7. Journal Article–Specific Rules

When the document is a **journal article or scholarly paper**, the following additional constraints apply.

### 7.1 Included Sections (Only These)
Only the following sections may enter RSVP:
- Abstract
- Introduction / Background
- Main body sections (Methods, Results, Discussion, Conclusions)

Section titles are **not fixed**. Inclusion must be inferred structurally and positionally.

---

### 7.2 Mandatory Exclusions
The following must be **completely excluded**:

- Author lists
- Author affiliations
- Correspondence information
- Email addresses
- ORCID IDs
- Institutional addresses
- Funding statements
- Acknowledgements
- Conflict of interest statements
- Ethics statements
- Data availability statements
- Supplementary material notices
- Footnotes unrelated to narrative text
- Reference lists / bibliographies
- Citation indices
- DOI and publication metadata
- Publisher boilerplate

None of the above may contribute tokens, anchors, or RSVP steps.

---

### 7.3 References
References are a **hard stop**:
- Once the reference section begins, **all following content is excluded**.
- Inline citations within narrative text remain (e.g. “[12]”, “(Smith et al., 2021)”).
- Reference entries themselves are excluded.

---

### 7.4 Detection Rules
Detection of excluded sections must be:
- Structural
- Layout-based
- Repetition-aware

Detection must **not** rely on:
- Keyword lists
- Publisher-specific templates
- Journal-specific formatting rules

---

### 7.5 Ambiguity Policy
If a block cannot be confidently classified as narrative:
- It must be excluded
- The exclusion must be logged

False exclusion is preferable to false inclusion.

---

## 8. Selection Behaviour

### 8.1 Selection Context
A selection defines a context of:
- Page
- Column
- Block

RSVP and anchoring must remain within this context unless the selection crosses boundaries.

---

### 8.2 Tokenisation Independence
The system must tolerate:
- Joined vs split tokens
- Superscripts and subscripts
- Font-size fragmentation
- PDF text-layer inconsistencies

Matching must not rely on:
- Exact token boundaries
- Domain-specific word lists
- Vocabulary heuristics

---

## 9. Anchoring Rules

### 9.1 Determinism
Given the same document and selection:
- Anchor generation must be deterministic
- Anchor re-resolution must produce the same target

---

### 9.2 Robustness
Anchors must survive:
- Renderer differences
- Re-extraction
- Minor layout variation

Anchors must not depend on:
- Absolute word indices
- Page-global ordering without column context

---

## 10. Universality Constraint

The system must not contain:
- Domain-specific word lists
- Subject-matter heuristics
- Acronym special cases
- Hard-coded vocabulary

All logic must be:
- Structural
- Layout-based
- Token-agnostic

---

## 11. Failure Policy

If content cannot be confidently classified:
- Prefer exclusion over inclusion
- Never allow excluded content into RSVP

Failures must be explicit and traceable in logs.

---

## 12. Non-Goals

The system is **not** required to:
- Interpret semantic meaning
- Understand subject matter
- Preserve visual fidelity

Only **reading order and narrative integrity** matter.

