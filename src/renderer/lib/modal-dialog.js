// Is a modal `<dialog>` up? (The bookmark add/edit editor, the profile-create
// and external-node prompts, onboarding — every `<dialog>` in the chrome is
// shown with `showModal()`.)
//
// A modal dialog puts itself in the top layer and makes everything outside it
// inert, so while one is open it *is* the innermost surface: the Escape
// belongs to it, and a click that lands on it (or on its backdrop) is aimed at
// it, never at whatever chrome surface is stranded behind it. Chrome's order,
// the same rule the menus follow — this press closes the dialog, the next one
// reaches the surface behind.
//
// The dialog cannot claim the press the way a menu handler does. Its Escape
// *is* the platform's own close request, dispatched only after every keydown
// listener has run and cancelled outright by a `preventDefault()` from any of
// them. So the other surfaces stand down on this probe instead, leaving the
// press uncancelled — a `preventDefault()` from one of them both keeps the
// dialog open and dismisses a surface the user cannot even see. See #306.
//
// The one deliberate exception is `chrome-input-context-menu.js`: it reparents
// itself *into* the open dialog, so it really is above it, and keeps its
// capture-phase Escape.
export const isModalDialogOpen = () => !!document.querySelector?.('dialog[open]');
