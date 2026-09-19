# Wiki pages

Every Markdown document in `workspace/wiki/` is a Page. Its YAML frontmatter is
the durable metadata source; its Markdown body stays in the file. SQLite stores
a rebuildable metadata index, never a second copy of the body. Task worktrees are
drafts: only files published into the main Wiki appear in the knowledge library.

New Pages have a UUID `id`, `title`, `objectType`, nullable `parentId`, `icon`,
`cover`, `favorite`, `trashed`, ISO `createdAt` and `updatedAt`, and a `properties`
mapping. Parent relationships use IDs so renaming a title does not break the tree.
New files use `<id>.md`; imported Markdown may live in nested directories. Plain
Markdown is also a Page: file-derived metadata is materialized on its first edit.
This is the Markdown import contract, not a historical database migration.

ObjectTypes are versioned in `wiki/_types.json` and indexed in SQLite. Types
declare named properties with stable keys, kinds (text, number, checkbox, date,
URL, select, multi-select, relation), and select options. Relations hold Page IDs.
Default types are Page, Note, Project, Person, and Meeting. The UI can create and
edit types. Removed fields retain their values in frontmatter; they are never
silently discarded. Invalid known field values prevent saving.

The library includes a nested page menu, favorites, recent pages, trash, search,
and type-specific table views with filtering and sorting. A Page has editable
title, icon, properties, parent, type, and Markdown-backed rich content. Page
actions include duplicate, move, favorite, trash, and restore. Trashing is
reversible; this version does not permanently delete files.

Wiki navigation sits below the workspace tools in one shared sidebar, following
the functional grouping and nested-page pattern in [Notion's sidebar reference](https://www.notion.com/help/navigate-with-the-sidebar).
There is no second sidebar inside the editor. Pages and ObjectTypes can be
collapsed, and page rows offer inline subpage creation. Narrow windows expose
the same navigation in a drawer, which closes after successful navigation.
The editor stays mounted across workspace sections so switching to Tasks does
not discard an unsaved draft; selecting another Wiki page first saves that draft.

Writes share the existing Vault Git write gate and check the file content hash
seen by the editor. Concurrent external/Agent changes return a conflict instead
of being overwritten. A successful editor save also records that file through the existing Git save
journal, so new Tasks see the latest Pages and ObjectTypes. Unrelated disk edits
remain in File Changes; Routine output continues through the existing
review/save/synchronize flow.
Indexing rereads canonical Markdown, reports malformed files separately, and
removes deleted file entries. A single bad Page must not hide the rest of the Wiki.

Completion requires service tests for file/index coherence, typed properties,
hierarchy, duplicate IDs, invalid frontmatter, conflicts, paths, and Routine
publication; renderer tests and a rendered interaction check for the library,
menus, property editing, and content persistence across reopening.

## Verification

`pnpm --filter @folio/desktop test` covers file/index coherence, typed fields,
RPC, editor state, Git publication, and lifetime retirement. After `pnpm build`,
`pnpm --filter @folio/desktop test:wiki` launches a real isolated Electron app,
creates a temporary Vault, verifies editing, reopening, favorites, ObjectTypes,
duplication, trash/restore, subpages, shared-sidebar placement, cross-section draft
preservation, and desktop/narrow/mobile navigation. It removes
the temporary Vault and prints the screenshot directory outside the repository.
