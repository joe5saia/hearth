/**
 * Floating menus and popovers close on a press outside them, on Escape, or when focus moves elsewhere,
 * as one app-wide rule. Mark a `<details>` with `data-dismiss` to opt in; Escape returns focus to its
 * summary. Inline disclosures that push content down (recipe details, Groceries sections) stay opt-out.
 */
export function installDismissal(root: Document = document) {
  const open = () => root.querySelectorAll<HTMLDetailsElement>("details[data-dismiss][open]");

  const closeOutside = (event: Event) => {
    for (const menu of open())
      if (!(event.target instanceof Node && menu.contains(event.target))) menu.open = false;
  };

  root.addEventListener("pointerdown", closeOutside);
  root.addEventListener("focusin", closeOutside);

  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !(event.target instanceof Element)) return;
    const menu = event.target.closest<HTMLDetailsElement>("details[data-dismiss][open]");

    if (!menu) return;
    // Keep an enclosing dialog open: Escape only closes the innermost menu.
    event.preventDefault();
    menu.open = false;
    menu.querySelector("summary")?.focus();
  });
}
