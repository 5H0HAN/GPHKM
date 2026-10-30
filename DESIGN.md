---
name: GPHKM
description: An editorial production flatplan for choosing and managing guest placements.
colors:
  ink-canvas: "#17202a"
  ink-surface: "#1d2731"
  ink-surface-raised: "#242f39"
  paper-canvas: "#f1eadb"
  paper-surface: "#f8f4eb"
  paper-surface-raised: "#e9e2d4"
  coral: "#ef7255"
  coral-hover: "#ff8b6e"
  coral-ink: "#1a2026"
  coral-light: "#c24830"
  coral-light-hover: "#a63e2d"
  coral-paper: "#fffaf1"
  sage: "#7fae9a"
  success-ink: "#9bd0b6"
  success-soft-ink: "#203c36"
  ink-rule: "#3b4650"
  paper-rule: "#d2c9b9"
  ink-text: "#f1eadb"
  paper-text: "#222b31"
  secondary-ink-text: "#d0c9bb"
  secondary-paper-text: "#404a4e"
  muted-ink-text: "#a9a69d"
  muted-paper-text: "#596365"
typography:
  display:
    fontFamily: "GPHKM Geist, Segoe UI, sans-serif"
    fontSize: "clamp(50px, 7vw, 92px)"
    fontWeight: 620
    lineHeight: 0.99
    letterSpacing: "-0.055em"
  headline:
    fontFamily: "GPHKM Geist, Segoe UI, sans-serif"
    fontSize: "clamp(32px, 4.8vw, 58px)"
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: "-0.045em"
  title:
    fontFamily: "GPHKM Geist, Segoe UI, sans-serif"
    fontSize: "clamp(40px, 6vw, 68px)"
    fontWeight: 620
    lineHeight: 1.02
    letterSpacing: "-0.05em"
  body:
    fontFamily: "GPHKM Geist, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "GPHKM Geist, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 650
    letterSpacing: "0.12em"
rounded:
  square: "0px"
  control: "5px"
  pill: "999px"
components:
  button-primary:
    backgroundColor: "{colors.coral}"
    textColor: "{colors.coral-ink}"
    rounded: "{rounded.square}"
    height: "50px"
    padding: "0 19px"
  button-primary-hover:
    backgroundColor: "{colors.coral-hover}"
  input-field:
    backgroundColor: "{colors.ink-canvas}"
    textColor: "{colors.ink-text}"
    rounded: "{rounded.square}"
    height: "44px"
  button-secondary:
    backgroundColor: "{colors.ink-surface-raised}"
    textColor: "{colors.ink-text}"
    rounded: "{rounded.control}"
    height: "44px"
  navigation-active:
    backgroundColor: "{colors.ink-surface-raised}"
    textColor: "{colors.ink-text}"
    rounded: "{rounded.square}"
    height: "46px"
  listing-card:
    backgroundColor: "{colors.ink-surface}"
    textColor: "{colors.ink-text}"
    rounded: "{rounded.square}"
    padding: "22px"
  status-approved:
    backgroundColor: "{colors.success-soft-ink}"
    textColor: "{colors.success-ink}"
    rounded: "{rounded.square}"
    height: "28px"
---

# Design System: GPHKM

## Overview

**Creative North Star: "The Editorial Production Flatplan"**

GPHKM is a placement production desk. Its editorial language comes from magazine flatplans, proof sheets, folio rules, and restrained correction marks. The dark workspace uses an ink ground, warm paper-toned type, coral action marks, and sage completion signals. The user-selectable light theme reverses the ink and paper roles while retaining the same hierarchy and contrast intent.

The interface favors direct labels, readable sans-serif type, ruled sections, and a clear path from choosing a placement to tracking its progress. Customer and staff workspaces share the visual language, while their information and permissions remain separate. The selected world avoids ornamental paper texture and fabricated editorial endorsement. English is the v1 language; customer and staff surfaces target responsive WCAG 2.2 AA.

**Key Characteristics:**
- Ink-and-paper tonal contrast with coral actions and sage completion.
- Folio rules and editorial titles paired with practical sans-serif controls.
- Customer and staff surfaces share form while keeping supplier and finance details private.
- Mobile layouts collapse into readable single-column work and compact navigation.

## Colors

The palette pairs deep blue-ink surfaces with warm paper text; coral is reserved for action and review cues, while sage marks positive completion.

### Primary
- **Proof coral**: the dark-theme primary action and active correction mark. The light theme uses the deeper coral-paper variant for its primary control.

### Secondary
- **Completion sage**: positive and approved status cues; it is not a substitute for a textual status label.

### Neutral
- **Blue ink**: the default canvas, raised work surfaces, and primary text in light mode.
- **Warm paper**: the light-theme canvas and the dark-theme primary text.
- **Ink rules**: dividers and borders against the dark canvas.
- **Paper rules**: borders and dividers against the light canvas.
- **Secondary and muted text**: supporting copy, metadata, and less prominent labels, with separate values in each theme.

### Named Rules
**The Correction Mark Rule.** Coral identifies a useful action, active selection, or review state. Do not use it as decoration without a task meaning.

## Typography

**Display Font:** Self-hosted Geist (with Segoe UI and sans-serif fallbacks)

**Body Font:** Self-hosted Geist (with Segoe UI and sans-serif fallbacks)
**Label/Mono Font:** No separate mono face is defined. Labels use the same Geist family.

**Character:** Geist keeps large editorial headings crisp without turning operational controls into display type. Body copy stays practical and open; labels use modest tracking to distinguish interface structure.

### Hierarchy
- **Display** (weight 620, responsive 50–92px, line-height 0.99): public hero heading.
- **Headline** (weight 600, responsive 32–58px, line-height 1.05): public workflow section headings.
- **Title** (weight 620, responsive 40–68px, line-height 1.02): customer and staff page titles.
- **Body** (weight 400, 15px desktop and 16px at widths up to 640px, line-height 1.55): explanatory and operational copy.
- **Label** (weight 650, 12px, letter spacing 0.12em, commonly uppercase): section labels and navigation grouping.

### Named Rules
**The One-Face Rule.** Use the self-hosted Geist family for display, body, and labels; no separate display or mono typeface is part of the current system.

## Layout

The public page uses a centered content width capped at 1240px. Customer pages center work content within a 1260px maximum inside a compact workspace shell. Staff pages use a wider operations canvas capped at 1680px, with grouped navigation and work-area-specific density. Section rules and generous page-title spacing establish hierarchy instead of stacks of unrelated dashboard cards.

The customer marketplace uses a two-column listing grid on wide screens and one listing per row at the 980px breakpoint. Its selected-order summary stays available at the bottom of the content area as a sticky checkout action. Customer and staff navigation collapse into a compact top bar with an expandable menu at 980px. The public page changes its hero and organization grids to one column by 820px and stacks workflow steps and footer content by 640px. Narrow layouts use reduced horizontal padding and full-width form controls. Relevant component breakpoints also include 1120px for the staff overview, 850px for Support, and 760px, 520px, 480px, and 440px for surface-specific layouts.

## Elevation & Depth

The visual system is flat at rest. Borders, ruled divisions, and slightly raised tonal surfaces define work areas. The sticky marketplace checkout has a restrained upward shadow so it remains distinguishable from listing content; focus is shown with a visible outline rather than a shadow.

### Shadow Vocabulary
- **Sticky checkout separation** (`0 -8px 28px color-mix(in srgb, var(--canvas) 90%, transparent)`): separates the persistent checkout action from scrolling catalog content.

### Named Rules
**The Rule-Over-Shadow Rule.** Use a border or tonal surface for ordinary structure; reserve the checkout shadow for its sticky overlap.

## Shapes

The editorial shell, navigation, primary action, and listing cards favor square corners. Form fields and a few supporting controls retain small radii where their component styles specify them. The support status badge retains its pill silhouette. Dividers remain crisp one-pixel rules; avoid clipping long content because customer-supplied text and URLs can be lengthy.

## Components

### Buttons
- **Shape:** Square-edged on the public primary action and redesigned customer/staff shell controls (0px); older supporting form components may retain their locally specified small radius.
- **Primary:** Coral fill with dark ink text in the default theme; the light theme uses its deeper coral and warm-paper text. Public hero CTA is 50px high with horizontal 19px padding; other surfaces use local component sizing.
- **Hover / Focus:** Primary actions shift to the theme's hover coral and lift by 1px where implemented. Keyboard focus uses a 2px theme focus outline with 2–3px offset.
- **Secondary / Ghost / Tertiary:** Use a ruled outline or a tonal surface, with text color and border from the active theme. Avoid representing an action only through color.

### Cards / Containers
- **Corner Style:** Square edges on the redesigned listing and primary workspace cards; supporting pages may retain their local radius.
- **Background:** Ink surface in dark mode and paper surface in light mode, with raised surfaces for nested facts and controls.
- **Shadow Strategy:** Flat borders and tonal contrast at rest; only the sticky marketplace checkout uses a shadow.
- **Border:** One-pixel rule in the active theme, strengthened for page boundaries and selected states.
- **Internal Padding:** Listing cards use 22px in the redesigned customer catalog. Other panels retain page-specific spacing.

### Inputs / Fields
- **Style:** Full-width where the form layout allows, with active-theme canvas fill, readable text, and a strong theme border. Redesigned marketplace controls have at least 44px height.
- **Focus:** A visible 2px theme focus outline with a 2–3px offset.
- **Error / Disabled:** Use explicit text and semantic alert/status regions; disabled buttons use a reduced-opacity state and wait/not-allowed cursor.

### Navigation
- **Style:** Grouped, literal labels in Geist with 44–46px targets. The active route receives a tonal fill and a 3px inset accent rule. On screens at or below 980px, the rail collapses to a top bar with an expandable menu; the menu control announces its expanded state.

### Marketplace Listing Card

The listing card is a proof sheet: a selection control and price sit above the website identity, customer-facing description, categories, placement facts, and attributed metrics. The customer-facing projection stays unified and does not reveal supplier identity, source class, cost, or internal evaluation. Selection is indicated with a changed border, and the final checkout remains a separate persistent action area.

## Do's and Don'ts

### Do:
- **Do** preserve the default dark theme and the user-selectable light theme with their separate, tested contrast roles.
- **Do** use self-hosted Geist and the existing color variables instead of adding a second font or parallel palette.
- **Do** keep labels literal and customer-facing copy neutral; preserve supplier confidentiality.
- **Do** use visible keyboard focus, semantic status text, and responsive controls sized for touch.
- **Do** use rules and tonal surfaces before adding depth effects.

### Don't:
- **Don't** expose supplier identity, source classification, internal costs, or margin in customer-facing surfaces.
- **Don't** imply guaranteed search ranking, indexing, or SEO outcomes.
- **Don't** add decorative textures, fabricated testimonials, or editorial endorsement.
- **Don't** use color alone to communicate selection, progress, or status.
