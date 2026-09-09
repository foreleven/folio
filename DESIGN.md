# Design Standards

## Principles

- Use a compact IDE layout with stable navigation, aligned controls, and generous space for content.
- Reduce redundant headings, nested containers, and decorative spacing before reducing text size or interaction targets.
- Establish hierarchy through alignment, typography, subtle surface differences, and thin separators.
- Keep names, statuses, and actions consistently aligned across related items.
- Reveal secondary details progressively. Keep essential instructions, current status, and the next action visible.
- Preserve comfortable typography for Markdown reading and editing independently of interface density.

## Typography

Use the shared system sans-serif font stack for interface text, with system fallbacks for CJK characters. Use a system monospace stack for code, paths, and keyboard shortcuts.

| Role | Font size | Line height | Weight |
| --- | --- | --- | --- |
| Navigation, lists, forms, buttons | 13px | 20px | 400; 500 for emphasis |
| Supporting text, paths, statuses | 12px | 18px | 400 |
| Section labels | 12px | 18px | 500 |
| Panel and settings titles | 14px | 20px | 600 |
| Welcome title | 18px | 24px | 600 |
| Markdown reading body | 16px | 26px | 400 |
| Markdown source editor | 14px | 22px | 400 |

- Keep interface text at least 12px at 100% zoom.
- Use no more than `0.04em` letter spacing for uppercase Latin section labels. Do not add letter spacing to CJK text.
- Allow document headings to follow the content hierarchy independently of interface title sizes.
- Limit the Markdown reading column to 760px with at least 24px horizontal padding. Allow source editors to use the available width.
- Do not compress the interface by changing the root font size or applying global CSS zoom.

## Spacing and Geometry

All dimensions are CSS pixels at 100% zoom. Application toolbar dimensions exclude the native window title bar.

| Spacing | Use |
| --- | --- |
| 2px | Fine alignment and spacing between related text lines |
| 4px | Closely related icons, indicators, and labels |
| 8px | Gaps between controls and horizontal list-row padding |
| 12px | Panel padding and gaps between information groups |
| 16px | Settings content padding and section spacing |
| 24px | Reading-area padding and separation between major regions |

- Keep routine settings-item padding below 24px.
- Avoid accumulating padding across parent containers, nested cards, and footers.
- Use 1px separators between adjacent panels or list items.
- Use square corners for structural panels, 2px radii for row highlights, and 4px radii for controls and labels.
- Limit embedded group radii to 6px. Use 8px radii for dialogs and floating surfaces.
- Reserve shadows for floating surfaces. Do not apply shadows to persistent panels or list items.
- Prefer a status dot with text over pill-shaped badges.

## Component Dimensions

| Component | Default dimensions |
| --- | --- |
| Workspace toolbar and editor tab bar | 36px high |
| Panel section header | 28px high |
| Settings page header | 40px high |
| Sidebar navigation and tree row | 28px high |
| Button, single-line input, select, segmented control | 28px high |
| Icon-button interaction target | 28 × 28px; minimum 24 × 24px |
| Standard icon | 16px; 14px for supporting icons |
| Integration logo | 24 × 24px |
| Status label | 12px text in a 20px line box |
| Two-line list item | Minimum 44px high |
| Integration summary row | 64px high when content fits |

- Use fixed heights only for single-line elements that can contain their text and controls.
- Allow descriptions, errors, translated text, and expanded details to increase row height.
- Keep controls aligned and avoid layout shifts during loading, saving, and status checks.
- Do not place logos inside oversized decorative containers.

## Color and Surfaces

Use shared semantic theme tokens. Light and dark themes must retain the same hierarchy, density, geometry, and interaction behavior.

| Token | Purpose |
| --- | --- |
| `background` / `foreground` | Content surfaces and primary text |
| `sidebar` / `sidebar-foreground` | Navigation surfaces and text |
| `muted` / `muted-foreground` | Supporting surfaces and secondary text |
| `border` / `input` | Structural separators and control boundaries |
| `accent` / `accent-foreground` | Hover and selection surfaces |
| `primary` / `primary-foreground` | The main action within a region |
| `ring` | Keyboard focus |
| `destructive` | Errors and destructive actions |

- Keep large surfaces neutral. Use brand colors only in small, purposeful areas.
- Use subtle surface differences between navigation and content.
- Avoid drawing a border around every nested container.
- Define success, progress, and warning colors as shared semantic tokens with light and dark values. Use green, blue, and amber respectively.
- Pair status colors with text or icons. Never communicate state through color alone.
- Maintain at least 4.5:1 contrast for primary and supporting text, and 3:1 for necessary control boundaries and focus indicators.

## Application Layout

- Fill the available workspace height.
- Keep toolbars and panel headers fixed while their content regions scroll independently.
- Allow panels and text containers to shrink without forcing horizontal page scrolling.
- Truncate long names and paths only when the full value remains accessible. Wrap essential descriptions and errors.
- Maintain usable navigation and actions at narrow widths and 200% zoom. Reflow controls and increase row heights as needed.
- Render controls and panels only when their associated functionality is available.

### Welcome

- Stack GET STARTED above RECENT VAULTS.
- Center the content horizontally, align it toward the top, and limit its width to 560px.
- Use 48px top spacing, reduced to 24px when the available content height is below 600px.
- Use a compact header with a 28px mark, an 18px title, and one short supporting sentence. Allow translated text to wrap.
- Separate the header and sections by 16px. Keep section labels 8px above their content.
- Present Open Vault as a 32px action row.
- Use 44px recent-vault rows with a name and path on separate lines, separated by 2px.
- Expose the full path through a tooltip and an accessible name that identifies the vault.
- Keep empty-state guidance to one or two short lines.
- Allow vertical scrolling when the content exceeds the available height.

### Settings

- Use a separate window with left navigation and a right content region.
- Set navigation width to 176px, reduced to 144px below a 640px window width.
- Keep the content left-aligned with a maximum width of 880px and 16px padding.
- Use a single-line 40px page header containing the section title and necessary actions.
- Show the Settings title once in the navigation header. Place supporting guidance beside the relevant setting.
- Keep the page header fixed. Scroll content and long navigation lists independently.
- Arrange settings as rows with labels on the left and controls on the right.
- Use minimum row heights of 44px for simple settings and 56px for settings with descriptions.
- Below a 480px content-region width, stack the control below its label with a 6px gap.
- Display automatic-save feedback as supporting text at the end of the group. Place save errors and recovery actions near the affected setting.

### Integrations

- Present providers as rows in a shared list with thin separators.
- Show a 24px logo, provider name, current status, and primary action in the summary. Use a second line for a brief description or registered resources.
- Use the provider's metadata for its identity, logo, description, and homepage link.
- Keep the default summary at 64px when content fits. Allow actions to move below the summary at narrow widths.
- Show a compact connected status and a secondary Check Status action for a ready integration.
- Keep installation effects and required dependencies visible before confirmation.
- Use provider-defined labels for available actions. Do not impose one provider's setup stages on another.
- Expand details on request and when authorization or errors require attention. Use 12px detail padding.
- Preserve a visible authorization-page action while waiting and readable recovery guidance on failure.
- Display success only when the integration reports `ready`. Resource registration alone must not appear as a connected state.
- Avoid separate decorative footers and repeated success descriptions.

### Vault Workspace

- Use a 36px toolbar for the vault name and contextual actions.
- Arrange navigation and document content in adjacent panels.
- Set the file sidebar to 220px by default, resizable between 180px and 320px.
- Use a dismissible 280px detail sidebar when contextual details are available.
- Collapse the detail sidebar before collapsing file navigation as the window narrows. Preserve at least 400px for the main editor where space permits.
- Limit width only for the Markdown reading column. Let toolbars, tabs, and source editors use their panel width.
- Place loading, empty, and unavailable-vault guidance inside the content panel with a clear next action.
- Preserve visible documents during background requests.

## Interaction and Accessibility

- Distinguish hover, selection, focus, and disabled states.
- Use a visible 2px keyboard focus ring that is not clipped by containers.
- Allow at most one primary action per region. Use secondary or ghost styling for supporting actions.
- Give every icon-only button an accessible name and a tooltip.
- Keep essential actions discoverable without hover.
- Provide complete keyboard access. Use arrow-key navigation where required by menu or tree semantics.
- Preserve focus when expanding details or completing an asynchronous operation. Return focus to the trigger when closing a dialog.
- Use platform-appropriate shortcut labels and expose only supported shortcuts.
- Match skeletons to the final row geometry.
- Announce progress through accessible status regions. Preserve content and recovery actions after failures.
- Use tooltips for supplementary information, never as the only source of essential instructions or errors.
- Restrict animation to brief feedback. Use 100–150ms color or opacity transitions and respect reduced-motion preferences.
- Avoid button displacement, persistent pulsing, and large layout animations.

## Shared UI Rules

- Use Tailwind CSS and the shared `@folio/ui` components.
- Define typography, dimensions, radii, and colors centrally through tokens and component variants.
- Reuse existing compact variants before introducing new ones.
- Keep interface typography separate from document typography.
- Use shared radius values of `sm=2px`, `md=4px`, `lg=6px`, and `xl=8px` consistently across components.
- Keep page composition within feature components and preserve the behavior of installation, authorization, saving, and vault operations.
