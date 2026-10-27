# Hybrid application theme

## Goal

Give Hub a light, dark, and system appearance aligned with gateway.huynle.com while preserving Hub's warmer editorial identity. Make rendered session content easier to scan through restrained semantic color, and update the application icon so its center node uses the shared teal brand color.

## Visual direction

The approved preview combines Gateway's cool neutral surfaces and teal brand accent with Hub's serif wordmark, compact shell, and monospace session content. Light mode uses a soft gray canvas, white raised controls, and dark neutral text. Dark mode uses near-black neutral surfaces rather than the previous brown charcoal. Navigation and controls remain quiet; color is concentrated in rendered session content.

Rendered Markdown uses violet headings, amber emphasis and list markers, green/teal links and inline identifiers, and blue function/meta accents. These roles adapt for contrast in both palettes. Syntax highlighting uses the same semantic palette. The treatment does not alter Markdown parsing or stored session content.

## Theme behavior

Appearance offers Light, System, and Dark. The choice is device-local. System is the default and follows `prefers-color-scheme`, including live OS changes. A small render-blocking script applies a stored explicit choice before first paint to avoid a palette flash. System mode is represented by the absence of a `data-theme` override, allowing CSS media queries to choose the palette.

The document advertises both color schemes and supplies separate browser theme colors for light and dark. The setting is accessible as a labeled three-option radio group and remains independent of the existing text-size preference.

## Brand mark and icons

The three satellite nodes and spokes continue to use a high-contrast neutral. The center node changes from peach to Gateway teal. Generated SVG, PNG, maskable, Apple touch, and favicon assets remain derived from `scripts/gen-icons.ts`; the inline `HubMark` uses the active theme's text and accent variables.

## Implementation and verification

Add a small theme preference module with validation, persistence, DOM application, and reactive UI state. Define light tokens first, explicit dark tokens second, and a matching system-dark media block. Convert hard-coded Markdown and shell colors to palette variables.

Tests cover preference validation/application and generated icon consistency. Existing Markdown, icon, type-check, build, and browser smoke coverage guard rendering and packaging. Capture light and dark screenshots for visual comparison against the approved preview and check narrow layouts for regressions.
