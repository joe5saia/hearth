const replaceableTypes = new Set(["text", "search", "number", "email", "url", "tel"]);

/** Resolves a press on a field, or on the label wrapping it, to an unfocused prefilled replaceable field. */
function pressedField(target: EventTarget | null) {
  const element = target instanceof Element ? target : null;

  const field =
    element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? element
      : element?.closest("label")?.control;

  const replaceable =
    (field instanceof HTMLInputElement && replaceableTypes.has(field.type)) ||
    (field instanceof HTMLTextAreaElement && field.dataset.selectOnFocus !== undefined);

  return replaceable &&
    !field.readOnly &&
    !field.disabled &&
    field.value !== "" &&
    field !== field.ownerDocument.activeElement
    ? field
    : null;
}

/**
 * Pressing or tapping into a prefilled single-line field selects its whole value, so typing replaces
 * it, as one app-wide rule. Leaving without typing keeps the value; a second press, an arrow key, or
 * a drag places the caret normally. Tabbing into an input already selects natively, and programmatic focus
 * keeps the caret its caller chose. Text areas keep native caret placement so one keystroke cannot
 * replace a note or instruction; a wrapping name field opts in with `data-select-on-focus`.
 */
export function installSelectOnFocus(root: Document = document) {
  // The field a press landed on before it had focus; every new press recomputes it.
  let pressed: ReturnType<typeof pressedField> = null;
  let mouse = false;

  root.addEventListener("pointerdown", (event) => {
    pressed = pressedField(event.target);
    mouse = event.pointerType === "mouse";
  });

  // A mouse may still drag out a partial selection, so mouse presses select only when they end.
  root.addEventListener("focusin", (event) => {
    if (pressed && event.target === pressed && !mouse) pressed.select();
  });

  // Browsers place the caret when the press ends, after focus; select then and keep it.
  root.addEventListener("mouseup", (event) => {
    const field = pressed;

    if (!field || field !== root.activeElement) return;
    pressed = null;
    // A drag that already chose part of the value keeps that choice.
    const { selectionStart: start, selectionEnd: end } = field;

    if (start !== end && (start !== 0 || end !== field.value.length)) return;
    event.preventDefault();
    field.select();
  });
}
