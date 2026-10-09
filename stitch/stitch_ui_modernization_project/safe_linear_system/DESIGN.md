---
name: Safe Linear System
colors:
  surface: '#12131a'
  surface-dim: '#12131a'
  surface-bright: '#383941'
  surface-container-lowest: '#0d0e15'
  surface-container-low: '#1a1b22'
  surface-container: '#1e1f26'
  surface-container-high: '#292931'
  surface-container-highest: '#33343c'
  on-surface: '#e3e1ec'
  on-surface-variant: '#bbcabf'
  inverse-surface: '#e3e1ec'
  inverse-on-surface: '#2f3038'
  outline: '#86948a'
  outline-variant: '#3c4a42'
  surface-tint: '#4edea3'
  primary: '#4edea3'
  on-primary: '#003824'
  primary-container: '#10b981'
  on-primary-container: '#00422b'
  inverse-primary: '#006c49'
  secondary: '#c0c1ff'
  on-secondary: '#1000a9'
  secondary-container: '#3131c0'
  on-secondary-container: '#b0b2ff'
  tertiary: '#4cd7f6'
  on-tertiary: '#003640'
  tertiary-container: '#00b2d0'
  on-tertiary-container: '#003f4b'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#6ffbbe'
  primary-fixed-dim: '#4edea3'
  on-primary-fixed: '#002113'
  on-primary-fixed-variant: '#005236'
  secondary-fixed: '#e1e0ff'
  secondary-fixed-dim: '#c0c1ff'
  on-secondary-fixed: '#07006c'
  on-secondary-fixed-variant: '#2f2ebe'
  tertiary-fixed: '#acedff'
  tertiary-fixed-dim: '#4cd7f6'
  on-tertiary-fixed: '#001f26'
  on-tertiary-fixed-variant: '#004e5c'
  background: '#12131a'
  on-background: '#e3e1ec'
  surface-variant: '#33343c'
typography:
  headline-lg:
    fontFamily: Inter
    fontSize: 1.75rem
    fontWeight: '600'
    lineHeight: 2.25rem
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Inter
    fontSize: 1.25rem
    fontWeight: '600'
    lineHeight: 1.75rem
    letterSpacing: -0.015em
  headline-sm:
    fontFamily: Inter
    fontSize: 1rem
    fontWeight: '600'
    lineHeight: 1.5rem
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Inter
    fontSize: 0.9375rem
    fontWeight: '400'
    lineHeight: 1.5rem
    letterSpacing: 0em
  body-md:
    fontFamily: Inter
    fontSize: 0.875rem
    fontWeight: '400'
    lineHeight: 1.25rem
    letterSpacing: 0em
  body-sm:
    fontFamily: Inter
    fontSize: 0.8125rem
    fontWeight: '400'
    lineHeight: 1.125rem
    letterSpacing: 0.005em
  label-md:
    fontFamily: Inter
    fontSize: 0.8125rem
    fontWeight: '500'
    lineHeight: 1rem
    letterSpacing: 0.01em
  label-sm:
    fontFamily: Inter
    fontSize: 0.6875rem
    fontWeight: '600'
    lineHeight: 0.875rem
    letterSpacing: 0.04em
  code-tabular:
    fontFamily: Inter
    fontSize: 0.75rem
    fontWeight: '500'
    lineHeight: 1rem
    letterSpacing: 0em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 1rem
  gutter-desktop: 1.5rem
  margin: 1rem
  margin-desktop: 2rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1.25rem
  space-xl: 2rem
---

## Brand & Style

This design system elevates developer-oriented educational productivity and background processing tools into an intuitive, razor-sharp workspace. It replaces low-contrast monochrome text dumps and cluttered raw terminals with a deliberate, high-legibility interface inspired by modern engineering power tools like Linear and GitHub Actions.

The visual style is characterized by:
- Deep zinc backgrounds with subtle optical lift across container layers.
- Sub-pixel borders in muted slate to partition nested content without visual noise.
- Crisp status indicators using high-visibility emerald to signify active listeners, successful transcriptions, and automated cron pipelines.
- Indigo accents for instructional actions, generative AI insights, and active schedule tags.
- Tabular numeric alignment and compact dense lists that preserve scanability while preventing visual fatigue.

## Colors

The palette is engineered for prolonged operational focus under dark mode conditions:
- **Primary (`#10B981` Emerald):** Reserved strictly for successful pipeline states, active background capture sessions, live listeners, and progress completions.
- **Secondary (`#6366F1` Indigo):** Applied to primary calls-to-action, active tab filters, key intelligence tags (e.g., AI transcript summary badges), and linked course identities.
- **Tertiary (`#06B6D4` Cyan):** Used for auxiliary system telemetries, batch count indicators, and session sync alerts.
- **Surface Neutrals:** Built upon a tailored zinc spectrum:
  - Base canvas: `#09090B` (neutral-950 deep canvas)
  - Card/Panel surface: `#18181B` (zinc-900 elevated tier)
  - Component surface/input: `#27272A` (zinc-800 focus and container fill)
  - Muted structural lines: `#27272A` with hover states brightening to `#3F3F46`.
  - Content hierarchy: Primary headers `#FAFAFA`, secondary descriptions `#A1A1AA`, and system readouts `#71717A`.

## Typography

Typographic scale is compact and dense, suited for high-density dashboard layouts. 

Key principles:
- **Tabular Numerals (`font-feature-settings: 'tnum'`):** Essential across all timestamps, quota countdowns, batch item totals, and course codes (e.g., `COMP303`, `08:30 AM`).
- **Hierarchy:** High-contrast headlines in pure white (`#FAFAFA`) pair with secondary body text in `#A1A1AA` to establish clear section boundaries.
- **Monospace Parity:** While Inter serves as the sole system typeface, data strings, API identifiers, and model parameters rely on tabular layout settings and compact size scales (`label-sm`, `code-tabular`) to maintain developer aesthetic precision while retaining polished readability.

## Layout & Spacing

The layout employs a constrained fluid container architecture designed to maximize horizontal utility without causing line lengths to drift past legible thresholds.

- **Grid Architecture:** 12-column desktop grid centered with a maximum boundary of `1280px` or `1440px` for wide screen consoles. Left/right canvas margin scales from `1rem` on mobile to `2rem` on desktop.
- **Section Rhythm:** Workspaces are split into distinct structural blocks:
  - Top persistent compact command header (48px height).
  - Main operational hub divided into structured panels (e.g., Timeline/Upcoming Schedule, Automated Pipeline Controls, and Course Task Repositories).
- **Internal Padding:** Dense component boundaries utilize consistent micro-spacing:
  - Inner card padding: `space-lg` (1.25rem).
  - Input and interactive button row heights: 32px to 36px with `space-sm` to `space-md` horizontal gaps.
  - Collapsible deadline items and activity feeds: `space-xs` vertical stacking with `space-sm` internal padding for scannability.

## Elevation & Depth

Visual hierarchy does not use aggressive, diffuse multi-color shadows. Instead, it relies on tonal separation complemented by fine sub-pixel borders:

- **Level 0 (Canvas Base):** Deep neutral `#09090B`. Ground layer for the entire application.
- **Level 1 (Panels & Surfaces):** `#121215` with a continuous `1px solid #27272A` boundary. Used for collapsible task sections, mapping tables, and module clusters.
- **Level 2 (Input Wells & Embedded Rows):** `#18181B` or `#1E1E22` for nested schedule rows, code pill tags, and key-value displays.
- **Level 3 (Modals, Overlays, Floating Controls):** `#18181B` with a subtle directional shadow `0 8px 24px -4px rgba(0, 0, 0, 0.6)` and an intensified border highlight (`#3F3F46`).
- **Active State Glow:** Active automation pipelines and recording indicators feature a delicate, focused emerald halo: `0 0 12px rgba(16, 185, 129, 0.25)`.

## Shapes

The design uses a restrained, compact rounding value (`roundedness: 1`):
- Standard base elements (buttons, form inputs, model status tags, code badges) receive `0.25rem` (4px) corner radius.
- Cards, panels, and collapsible deadline tables utilize `0.5rem` (8px, `rounded-lg`) to soften structured containers while preserving technical precision.
- Interactive status pills and live ping dots make strict use of circular capsules (`rounded-full`) exclusively for visual accents and counts.

## Components

### Buttons & Interactive Controls
- **Primary Buttons:** High-contrast solid Emerald (`#10B981`) or Indigo (`#6366F1`) with text in dark `#042F2E` or bright `#FFFFFF`, sized to 32px height, 4px border radius, with medium font weight.
- **Secondary / Ghost Buttons:** Neutral dark background (`#27272A`) with subtle border (`#3F3F46`) and light text (`#E4E4E7`).
- **Utility Actions ("Ask AI", "+ Checklist", "Fold"):** Compact micro-actions with 24px height, inline typography (`0.75rem`), and soft hover backgrounds to replace cluttered hyperlinks.

### Inputs & Key-Value Configuration Fields
- **Fields:** Surface fill `#18181B` paired with a sharp 1px border `#27272A`. In focus state, rings are replaced with an explicit border transition to Emerald (`#10B981`) or Indigo (`#6366F1`) with zero horizontal jitter.
- **Integrated Labels & Token Suffixes:** Suffix items like `[use env]` or batch sizes are integrated directly into the input well as nested neutral tags.

### Status Badges & Chips
- **Live Indicator:** Small 6px animated pulsing beacon in `#10B981` paired with a subdued emerald badge (`bg-emerald-950/40 text-emerald-400 border border-emerald-800/50`).
- **Course Tag Badges:** Rectangular tags with `rounded-sm` border radius, subtle dark neutral fills (`#27272A`), and concise course identifiers (e.g., `COMP309`).
- **Urgency Tags:** Overdue alerts display a muted crimson tone (`#EF4444`) to direct focus without visually overpowering the screen.

### Collapsible Deadline & Schedule Cards
- **Header Structure:** Header displays course title, timestamp (in tabular font), and aggregate progress pills (e.g., `108 open · 37 done · 1 overdue`).
- **Expansion State:** Smooth collapse/expand trigger aligned to the right. Expanded state reveals checklists, AI session notes, and direct course shortcuts without breaking page balance.

### Data Tables & Mapping Rows
- **List / Table Rows:** Subtle zebra striping or top/bottom border dividers (`#1F1F23`). Cell alignment prioritizes tabular numbers for dates, times, and batch processing telemetry.
- **Actions:** Quick mapping actions (`Remove`, `Re-link`, `Rebuild`) remain subdued until hover to keep dense interfaces calm.