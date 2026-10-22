# Curtis AI Audit — Design Notes

> Plugin UI inherits the user's Obsidian theme (CSS variables) — same rule as
> all Curtis plugins: never paint NEWELL green into app chrome. Brand surfaces
> (docs site, OG art, README imagery) have their own recorded palette below.
> Canonical code source: `site/index.html` `:root` block.

## Docs-site palette — "Curtis Records Office" (same family as curtis-ai-porter)

| Token | Hex | Role |
|---|---|---|
| `--bg` | `#F5F5F3` | Paper background |
| `--panel` / `--panel-2` | `#FFFFFF` / `#F0F2EC` | Panels |
| `--border` | `#DDE0D8` | Hairlines |
| `--text` / `--muted` | `#1A1A18` / `#6B6B66` | Text |
| `--accent` | `#0E7A45` | Green-700 — the ONLY accent |

**Retired colors: `#00FF41`, `#1AFF72` (NEWELL neon) — do not reintroduce.**

## Typography

- Voice/serif: Fraunces (Georgia fallback) — headings, brand.
- Mono: IBM Plex Mono — code, section tags, step numbers.

## Plugin UI rules

- Style only via Obsidian variables (`--background-*`, `--text-*`,
  `--interactive-accent`, `--radius-s/m/l`). Zero hardcoded brand colors.
- The green lives in the logo disc and marketing surfaces, not chrome.
