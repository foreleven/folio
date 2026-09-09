# Folio Design Standards

This document defines the interface design and implementation standards for the Folio desktop application, including Welcome, the independent Settings window, integrations, and the vault workspace. The goal is a calm, compact, clear environment for reading and working with content.

These standards describe target behavior, not a claim that every capability exists. File trees, document tabs, Markdown editors, and detail sidebars apply when their corresponding features are implemented; the current vault workspace remains an overview. Do not display unavailable controls or fabricated data to satisfy a layout. These standards do not prescribe the visual style of independent user-created artifacts such as HTML pages or posters.

## 1. Principles and Decision Order

1. **Prioritize content.** Give documents, names, current status, and the next action the most attention.
2. **Stay compact and readable.** Remove redundant headings, nested containers, and excess spacing before reducing text size or interaction targets.
3. **Keep positions stable.** Align names, statuses, and actions across related rows. Loading, saving, and errors must not displace buttons.
4. **Reveal details progressively.** Show information needed for decisions by default. Expand secondary details on demand; keep errors, authorization entry points, and essential guidance visible.
5. **Represent state accurately.** Reflect confirmed business state. Sending a request, registering a resource, or completing an animation does not establish success.
6. **Use restrained, consistent styling.** Reuse components and semantic tokens. Establish hierarchy through typography, alignment, subtle surfaces, and thin separators.

When rules conflict, prioritize correct data and behavior, accessibility, and complete content, followed by interaction consistency and visual density. Keep exceptions local to the affected component and explain them in the change description. Do not resolve local problems with global overrides.

## 2. Sources and Implementation Conventions

| Concern | Source and convention |
| --- | --- |
| Themes, fonts, and base styles | `packages/ui/src/styles.css`, the single shared stylesheet entry |
| Interactive components | `packages/ui/src/components/ui/`, imported through `@folio/ui` |
| Page composition and responsive rules | TSX in feature directories, using Tailwind CSS v4 utilities |
| Component behavior | Preserve the focus, keyboard, and semantic behavior of existing Base UI primitives |
| Icons | Reuse existing Lucide icons; use provider metadata for brand assets |
| Business states and actions | Follow actual RPC contracts, protocols, and provider definitions; designs do not introduce API states |

- Inspect existing definitions before adding shared colors, dimensions, or variants. Add reusable definitions in the shared layer; do not duplicate theme variables per page.
- Do not add page-specific stylesheet entries or another CSS reset. Tailwind Preflight supplies the reset.
- Keep page composition in feature components. Shared UI components must not own authorization, installation, saving, or vault business logic.
- Dimensions in this document are design baselines. Centralize repeated dimensions that lack tokens when implementing the relevant feature; do not assume those tokens already exist.
- Updating this document does not update components automatically. Identify affected pages and implementation scope when changing shared standards.

## 3. Typography

Use the shared sans-serif stack: Inter when available, system UI fonts, and system CJK fallbacks. Do not introduce a remote font for an individual page. Use a consistent system monospace stack for code, paths, and keyboard shortcuts.

| Role | Font size | Line height | Weight |
| --- | --- | --- | --- |
| Navigation, lists, forms, buttons | 13px | 20px | 400; 500 for emphasis |
| Supporting text, paths, statuses | 12px | 18px | 400 |
| Section labels | 12px | 18px | 500 |
| Panel and settings titles | 14px | 20px | 600 |
| Welcome title | 18px | 24px | 600 |
| Markdown reading body | 16px | 26px | 400 |
| Markdown source editor | 14px | 22px | 400 |

- Keep interface text at least 12px at 100% zoom. Do not compress the interface by changing the root font size or applying global CSS zoom.
- Usually use two text levels within a region: primary content and supporting information. Avoid combining larger size, bold weight, brand color, and background emphasis on the same element.
- Do not add letter spacing to CJK text. Uppercase Latin section labels may use at most `0.04em`; use natural capitalization for ordinary buttons.
- Use semantic heading levels without skipping levels for visual sizing. Document headings follow their own hierarchy independently of interface titles.
- Limit the reading column to 760px with at least 24px horizontal padding by default, reduced to 16px in narrow spaces. Source editors use the available width.
- Usually truncate names to one line. Wrap essential guidance, errors, and user input. Make full names and paths available through keyboard-accessible details or tooltips, not only native `title` attributes.
- Use tabular numerals for frequently changing counts or progress values when needed to prevent width shifts.

## 4. Spacing, Dimensions, and Geometry

All dimensions are CSS pixels at 100% zoom. Application toolbar heights exclude the native window title bar.

| Spacing | Use |
| --- | --- |
| 2px | Fine spacing between related text lines |
| 4px | Closely related icons, labels, and indicators |
| 8px | Control gaps and horizontal list-row padding |
| 12px | Panel padding and information-group gaps |
| 16px | Settings content padding and section spacing |
| 24px | Reading-area padding and separation between major regions |

Reserve 6px gaps for established compact-control internals and stacked form labels in narrow layouts. Do not expand them into a competing page-spacing scale.

| Component | Default dimensions |
| --- | --- |
| Workspace toolbar and editor tab bar | 36px high |
| Panel section header | 28px high |
| Settings page header | 40px high |
| Sidebar navigation and tree row | 28px high |
| Button, single-line input, select, segmented control | 28px high |
| Icon-button interaction target | 28 × 28px; minimum 24 × 24px |
| Standard / supporting icon | 16px / 14px |
| Integration logo | 24 × 24px |
| Status label | 12px text in a 20px line box |
| Two-line list item | Minimum 44px high |
| Integration summary row | 64px high when content fits |

- Use fixed heights only for single-line elements that can contain their content. Translations, errors, descriptions, and expanded details must be able to increase height.
- Use shared Button and Input variants for default control heights. Do not shrink interaction targets merely to align visible elements.
- For touch or coarse-pointer input, primary interaction targets must be at least 44 × 44px; allow row heights to grow accordingly.
- Use 1px separators between adjacent structural regions. Avoid repeated borders around parents, cards, and card contents.
- Use square corners for structural panels, 2px radii for row highlights, 4px for controls, at most 6px for embedded groups, and 8px for dialogs and floating surfaces.
- Shared radii are `sm=2px`, `md=4px`, `lg=6px`, and `xl=8px`, derived from the existing `--radius=6px`.
- Reserve shadows for floating surfaces such as menus and dialogs. Persistent panels and rows have no shadows. Avoid decorative gradients and blurred backgrounds.
- Keep routine settings-item padding below 24px. Account for accumulated parent and child padding rather than evaluating each container in isolation.

## 5. Color and Themes

Use shared semantic tokens. Light and dark themes retain the same layout, density, and interactions. Shared styles define the actual color values; do not hardcode page-level substitutes.

| Token | Purpose |
| --- | --- |
| `background` / `foreground` | Main content surfaces and text |
| `sidebar` / `sidebar-foreground` | Navigation surfaces and text |
| `card` / `card-foreground` | Content surfaces that need distinct grouping |
| `popover` / `popover-foreground` | Floating surfaces such as menus and tooltips |
| `muted` / `muted-foreground` | Supporting surfaces and secondary text |
| `border` / `input` | Structural separators and control boundaries |
| `accent` / `accent-foreground` | General hover and selection surfaces |
| `sidebar-accent` / `sidebar-accent-foreground` | Selected navigation surfaces and text |
| `primary` / `primary-foreground` | The main action within a region and its text |
| `secondary` / `secondary-foreground` | Supporting actions |
| `ring` | Keyboard focus |
| `success` / `progress` / `warning` | Success, ongoing work, and attention; green, blue, and amber respectively |
| `destructive` | Errors and destructive actions |

- Keep large surfaces neutral. Use brand color for primary actions, small status areas, and identity.
- Pair status colors with text or meaningful icons. Color alone must never communicate state.
- Maintain at least 4.5:1 contrast for primary and supporting text, and 3:1 for necessary control boundaries and focus indicators. Decorative separators must not be the only way to identify a control.
- Preserve text readability when reducing opacity. Ordinary supporting text must not resemble disabled content.
- Pair status-colored backgrounds with readable foregrounds. Do not assume existing status tokens are suitable for every filled surface.
- Do not generate dark mode by inverting the entire interface. Preserve logo proportions and recognizability; use an equally sized fallback icon when an asset is missing.
- Follow OS preferences in `system` mode. Preserve the user's explicit light or dark selection otherwise.

## 6. Layout and Space Constraints

- Fill the available workspace height. Keep toolbars fixed and content regions independently scrollable; avoid unnecessary nested scrolling along the same axis.
- Allow flex and grid children to shrink, using `min-w-0` and `min-h-0` as needed. Ordinary forms must not require page-level horizontal scrolling.
- Long code and wide tables may scroll horizontally within their own regions without moving the entire page.
- Prefer content-region width for responsive decisions. Use window width for whole-window layout rules; do not conflate the two.

| Condition | Adaptation |
| --- | --- |
| Settings window below 640px wide | Reduce navigation from 176px to 144px |
| Settings content region below 480px wide | Stack controls below labels with a 6px gap |
| Settings still cannot fit in two columns | Replace navigation with a compact, keyboard-accessible section selector instead of further squeezing the form |
| Workspace becomes narrow | Collapse the detail sidebar before file navigation; preserve a discoverable reopening control |
| Main editor has less than 400px available | Switch to a single main panel; 400px is a target when space permits, not a mandatory minimum window width |
| Short window or 200% zoom | Allow scrolling and wrapping while keeping primary actions and closing controls reachable |

Do not reset user-adjusted panel widths during routine data refreshes. Display resize handles only when resizing is supported. Handles need an appropriate pointer cursor and keyboard resizing or an equivalent size control.

## 7. Component Standards

### Buttons and Action Hierarchy

- Allow at most one primary action per independent task region. Use `secondary`, `outline`, or `ghost` for supporting actions.
- Use verb-and-object labels such as “Open Vault” and “Check Status.” Context may make a short label such as “Retry” sufficient.
- Every icon-only button needs an accessible name and a tooltip available on focus. Hide decorative icons from assistive technology.
- Keep essential actions visible by default. Secondary row actions may appear on hover or focus-within.
- Preserve button space during submission, show action-specific progress text, and prevent duplicate submission of the same request.
- Explain disabled states in context. Do not use disabled buttons as substitutes for explaining unavailable features.
- Use link semantics for external navigation and button semantics for state-changing actions. Do not imitate buttons with clickable `div` elements.

### Inputs and Forms

- Give each control a persistent visible label. Placeholders provide format examples, not labels or required-field instructions.
- Use a consistent order: label, necessary guidance, control, field error. Associate guidance and errors with their controls using appropriate attributes.
- Show validation errors after blur or submission, not before the user begins. Update feedback promptly after correction.
- Explain recovery specifically, such as “Enter a valid URL,” instead of only “Invalid value.”
- Preserve input after submission failure. Place form-level errors near the form and field errors beneath the affected field.
- After a multi-field submission fails, focus the first invalid field. Background validation must not steal focus.
- Use switches for immediately applied binary preferences, checkboxes for multiple independent choices, and radio groups or segmented controls for a small set of mutually exclusive options.
- Make the saving model explicit for each feature. Do not mix automatic saving and unexplained submit buttons within the same group.
- Mask sensitive values by default. Do not repeat credentials in tooltips, errors, notifications, or diagnostic details.

### Lists, Navigation, and File Trees

- Keep the order of icons, names, supporting information, statuses, and actions consistent across related rows. Action placement must not drift with name length.
- Current navigation, list selection, hover, and keyboard focus are distinct states and may coexist.
- Selecting a row must not trigger deletion or another secondary action. Avoid nested buttons and conflicting event behavior.
- File trees follow tree semantics: arrow keys navigate and expand, and Home/End move to the first/last item. Use the `tree` role only with its full interaction behavior.
- Distinguish an empty list, no search results, and a loading failure. Do not obscure these conditions with a generic “No data” message.
- Preserve scroll and focus stability in large collections. Virtualization must not lose the focused or selected item.

### Menus, Tooltips, and Dialogs

- Menus contain available contextual secondary actions. Separate destructive actions from ordinary actions and label them explicitly.
- Menus support arrow keys, Enter, and Escape. Return focus to the trigger on close. Close the topmost nested surface first.
- Tooltips supplement information. They must not contain interactive controls, required steps, or the only error explanation.
- Dialogs have a default maximum width of 480px, increased to 640px for complex forms. Leave at least 16px around the window edges and scroll overflowing content internally.
- Use 16px dialog padding and section gaps, with 14px/20px interface title typography.
- Modal dialogs need an accessible name, focus containment, and an accessible closing action. The backdrop blocks background interaction; background tooltips must not appear above the modal.
- Choose an appropriate initial control for ordinary dialogs. For irreversible actions, initially focus a safe action such as Cancel. Confirmation copy names the target and actual consequences.
- Avoid nested modals. Prevent accidental loss when closing forms with unsubmitted data; do not overuse confirmations for routine reversible actions.
- Keep stacking order consistent: content, fixed bars, nonmodal surfaces, modal backdrop and dialog, then surfaces within that dialog. Avoid arbitrary extreme page-level z-index values.

## 8. States and Feedback

The following defines presentation requirements, not new backend state enums.

| State | Presentation | Action behavior |
| --- | --- | --- |
| Initial loading | Brief status or skeleton matching the final structure within the target region | Do not show a false empty state |
| Background refresh | Preserve existing content with a local progress indicator | Restrict only conflicting actions |
| Empty content | Explain what is missing and give an actionable next step | At most one primary entry point |
| No search results | Preserve the query and explain that nothing matches | Offer clearing filters or changing the query |
| Saving | Show “Saving…” within the affected group | Avoid duplicate writes and control displacement |
| Saved | Show lightweight feedback only after confirmed persistence | Do not require a success confirmation dialog |
| Save failed | Preserve recoverable input and explain that it is unsaved | Keep retry or correction nearby |
| Operation failed | Identify the affected object, impact, and recovery path | Do not replace usable content with a full-page error |
| Awaiting authorization | Explain the action needed outside the app | Preserve a way to reopen the authorization page |
| Content unavailable | Distinguish missing content, access failure, and read failure | Offer only supported recovery actions |

- Place feedback near its trigger. Transient notifications are suitable only for information that needs no sustained reading; they must not be the sole recovery path.
- Use indeterminate progress when progress is unknown. Display percentages only when real measurements are available.
- Announce ordinary progress through polite live regions. Errors needing immediate attention may use an alert; avoid repeated announcements on every render.
- Do not hide failure behind an endless spinner. When a request actually times out or the service returns an error, show a recoverable state. Do not fabricate completion times.
- If preference saving fails, the previously committed preferences remain effective. Distinguish pending input from the currently applied state.

## 9. Page Standards

### Welcome

- Stack GET STARTED above RECENT VAULTS, with headings localized to the current language.
- Center content horizontally, align it toward the top, and limit width to 560px. Use 48px top spacing, reduced to 24px when available content height is below 600px.
- Use a 28px brand mark, an 18px title, and one short supporting sentence. Leave 16px between the header and sections and 8px between section labels and content.
- Present Open Vault as a 32px action row. Recent-vault rows use a 44px two-line layout by default, with 2px between name and path.
- Distinguish identically named vaults by path. Accessible names must identify the target. Make full paths available without forcing the row wider.
- Keep empty-state guidance to one or two short lines. Preserve the list and recovery action after an opening failure. Allow vertical scrolling when needed.

### Settings

- Use an independent window with navigation on the left and content on the right. Show “Settings” once in the navigation header.
- Keep content left-aligned, at most 880px wide, with 16px padding. The 40px page header contains only the current section title and necessary actions.
- Keep the header fixed and scroll content and long navigation lists independently. Allow header height to grow if wrapped text or zoom requires it.
- Simple rows have a minimum height of 44px; rows with descriptions use 56px. Place labels left and controls right by default, stacking them in narrow regions as defined in Section 6.
- Group settings by user task. Keep guidance beside the relevant setting rather than accumulating instructions at the top of the page.
- Place automatic-save feedback at the end of its group, with failures and recovery near the affected setting. Global preferences such as theme and language follow committed shared state.

### Integrations

- Present providers in a shared list with thin separators. Summaries contain a 24px logo, name, current status, and main action; use a second line for a brief description or resource information.
- Keep summaries 64px high when content fits. Move actions below in narrow regions and use 12px detail padding. Do not place logos in oversized decorative containers.
- Use provider metadata for names, logos, descriptions, homepages, action labels, and state meanings. Do not impose another provider's installation stages.
- Expand details on user request or when authorization or errors require attention. Expansion must not steal focus from existing input.
- Show actual installation effects and required dependencies before installation. Preserve a visible authorization-page action while waiting and readable recovery guidance on failure.
- Show connected success only when the integration reports `ready`. Resource registration does not establish connection, and a busy indicator must not obscure an existing error.
- Ready integrations show compact status and a secondary Check Status action, subject to provider-defined action availability.
- Avoid repeated success descriptions and decorative footers. Removal and disconnection labels must describe their actual effects without implying local files will be deleted.

### Vault Workspace

- Use a 36px top toolbar for the vault name and contextual actions, with navigation beside main content.
- Target a default file-sidebar width of 220px, adjustable between 180px and 320px when resizing is supported. A dismissible detail sidebar targets 280px.
- Follow Section 6 when space is constrained. Preserve reopening controls for collapsed panels and avoid losing context on expansion.
- Toolbars, tab bars, and source editors fill their panels. Only the Markdown reading column has a width limit.
- Place loading, empty, and unavailable-vault guidance inside the content panel with a clear next action. Preserve visible documents during background requests.
- Closing a window, removing a recent entry, and deleting files from disk are distinct operations. Labels and confirmations must not conflate them.

### Document Reading and Editing (When Implemented)

- Preserve document position and user context when switching between reading and editing where possible. Distinguish saved, unsaved, and save-failed states.
- Use 16px paragraph spacing by default. Leave 24px before document headings and 12px after them, avoiding duplicate top spacing before the first heading.
- Make links identifiable within text and keyboard-focusable. Code blocks use monospace text and local horizontal scrolling.
- Images retain their aspect ratio and do not exceed the content column. Tables may scroll horizontally rather than compress text beyond readability.
- Do not truncate document content. Text selection must not initiate interface dragging, and shortcuts must not submit actions during IME composition.
- Show unsaved indicators only when backed by actual save state. Timers and editing animations must not imply successful persistence.

## 10. Keyboard, Accessibility, and Desktop Behavior

- Make every action keyboard-accessible. Tab order follows visual reading order; do not use positive `tabIndex` values to repair layout.
- Provide a visible 2px focus ring that is not clipped by overflow or obscured by fixed headers. Selection styling does not replace focus styling.
- Return focus to the trigger when closing a floating surface. If the trigger was removed, move focus to an adjacent item or a sensible entry point in the parent region.
- Expose the current navigation item to assistive technology. Navigation, trees, and tabs use their respective semantics rather than interchangeable roles.
- Display platform-appropriate shortcuts: Cmd on macOS and Ctrl on Windows/Linux. Show only implemented, available shortcuts.
- Preserve essential text editing, clipboard, and IME keys. Escape acts on the innermost dismissible context first.
- Respect native window controls when using the native title bar. Buttons, inputs, and selectable text within custom drag regions must remain interactive.
- Keep content and primary actions accessible at 200% zoom. Do not push closing or saving controls outside the window through forced minimum widths.

## 11. Writing and Internationalization

- Write concise, specific, actionable copy. Success messages describe results; error messages describe impact and recovery.
- Use consistent terminology: Vault, Settings, and Integrations. Their Simplified Chinese equivalents are “知识库,” “设置,” and “集成.” Preserve provider-specific names.
- Maintain the same information structure in English and Chinese. Localize complete messages rather than concatenating sentence fragments; handle quantities and punctuation for the locale.
- Allow longer translations to wrap. Do not derive fixed column widths solely from English label lengths.
- Format dates, times, and numbers for the active locale. Preserve original paths and user filenames.
- Do not expose stack traces, RPC type names, or credentials in primary error copy. Necessary diagnostic details may be collapsible and offer safe copyable content.

| Avoid | Prefer |
| --- | --- |
| Operation failed | Could not open this vault. Check that the folder still exists, then retry. |
| Success! | Settings saved |
| No data | No recent vaults yet. Open a folder to get started. |
| Are you sure you want to delete? | Name the item being deleted or removed and explain whether files on disk are affected |

## 12. Motion

- Use motion for state feedback. Color and opacity transitions default to 100–150ms. Avoid large movements, scaling, and persistent pulsing.
- Match skeleton geometry to final content and keep loading icons from changing button widths. Routine refreshes must not replay whole-page entrance animations.
- Respect `prefers-reduced-motion`: disable nonessential transitions and looping animations, using static progress text instead.
- Animation completion must not establish successful submission, connection, or content availability.

## 13. Design Deliverables and Review Criteria

For a new page or significant component, describe the user task, information hierarchy, primary action, relevant states, narrow-layout behavior, keyboard interaction, and any new shared tokens or variants. Simple copy changes do not require a complete design mockup.

The following checklist applies to subsequent interface implementation. It does not imply that this document change has been run or tested:

- [ ] Shared fonts, colors, radii, and components are used without introducing a parallel styling system.
- [ ] Primary content and the next action are clear, without repeated headings, nested decorative cards, or excess spacing.
- [ ] Default, hover, focus, selection, disabled, and busy states remain distinguishable.
- [ ] Initial loading, empty, failure, success, and background-refresh states reflect actual capabilities.
- [ ] Long names, paths, multiline errors, English and Chinese text, and 200% zoom do not obscure essential actions.
- [ ] Text and necessary boundaries remain legible in light and dark themes; status does not rely only on color.
- [ ] Keyboard users can complete primary flows, focus returns appropriately after dialogs close, and icon buttons have names.
- [ ] Save failures preserve input, and integration connection states are not misrepresented by resource registration or busy indicators.
- [ ] Unimplemented features are not displayed merely to match a design, and existing business behavior is preserved.

Document each new exception with its scope, reason, and alternative approach. Promote reusable exceptions into shared rules rather than accumulating conflicting page conventions.
