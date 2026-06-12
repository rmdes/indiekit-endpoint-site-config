/**
 * Composition editor enhancements (D4). Enhancement ONLY — the page is fully
 * operable without JS (move-up/down forms, per-zone noscript add disclosures).
 * No fetch: every interaction builds/submits a regular form and navigates.
 *
 * Sortable.min.js is a UMD vendor file loaded via its own deferred
 * `<script src=".../vendor/Sortable.min.js">` tag BEFORE this module (defer
 * and module scripts execute in document order), exposing `window.Sortable`.
 */

const UNDO_DISMISS_MS = 10_000;

/** Read the i18n bootstrap rendered by the view. */
function readI18n() {
  const element = document.querySelector("#sc-editor-i18n");
  if (!element) return {};
  try {
    return JSON.parse(element.textContent);
  } catch {
    return {};
  }
}

/** Build and submit a plain POST form (full page reload is fine). */
function submitPost(action, fields) {
  const form = document.createElement("form");
  form.method = "post";
  form.action = action;
  form.hidden = true;
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  form.submit();
}

/** (1) Drag-and-drop reordering via SortableJS on each zone list. */
function initSortable() {
  const Sortable = globalThis.Sortable;
  if (!Sortable) return;
  for (const list of document.querySelectorAll("[data-sc-zone]")) {
    new Sortable(list, {
      group: "sc-zones",
      draggable: ".sc-block-card",
      animation: 150,
      ghostClass: "sortable-ghost",
      chosenClass: "sortable-chosen",
      onEnd(event) {
        const blockId = event.item.dataset.scBlock;
        const zone = event.to.dataset.scZone;
        if (!blockId || !zone) return;
        const sameSpot =
          event.from === event.to && event.oldIndex === event.newIndex;
        if (sameSpot) return;
        const index = [...event.to.querySelectorAll(".sc-block-card")].indexOf(
          event.item,
        );
        submitPost(
          `/site-config/design/homepage/blocks/${encodeURIComponent(blockId)}/move-to-index`,
          { zone, index: String(index) },
        );
      },
    });
  }
}

/** (2) Reveal the per-zone Add buttons (the dialog needs JS) and preset the
 * dialog's zone selects to the zone whose button opened it. */
function initAddDialog() {
  const dialog = document.querySelector("#sc-add-dialog");
  for (const button of document.querySelectorAll(
    '[data-modal-open="sc-add-dialog"][data-sc-zone-for]',
  )) {
    button.hidden = false;
    button.addEventListener("click", () => {
      if (!dialog) return;
      const zone = button.dataset.scZoneFor;
      for (const select of dialog.querySelectorAll("[data-sc-zone-select]")) {
        const option = [...select.options].find((o) => o.value === zone);
        if (option) select.value = zone;
        // Entries that can't live in this zone stay visible (the server
        // gates placement anyway) but keep their own first legal zone.
      }
    });
  }
}

/** (3) Client-side filtering of the add dialog by block label. */
function initSearchFilter(i18n) {
  const filter = document.querySelector("[data-sc-filter]");
  const dialog = document.querySelector("#sc-add-dialog");
  if (!filter || !dialog) return;
  const empty = dialog.querySelector("[data-sc-filter-empty]");
  if (empty && i18n.searchEmpty) empty.textContent = i18n.searchEmpty;

  filter.addEventListener("input", () => {
    const query = filter.value.trim().toLowerCase();
    let anyVisible = false;
    for (const entry of dialog.querySelectorAll("[data-sc-label]")) {
      const matches =
        query === "" ||
        (entry.dataset.scLabel || "").toLowerCase().includes(query);
      entry.hidden = !matches;
      if (matches) anyVisible = true;
    }
    for (const group of dialog.querySelectorAll("[data-sc-group]")) {
      const hasVisible = [...group.querySelectorAll("[data-sc-label]")].some(
        (entry) => !entry.hidden,
      );
      group.hidden = !hasVisible;
    }
    if (empty) empty.hidden = anyVisible;
  });
}

/** (4) Auto-dismiss the Undo flash after 10s; pause forever on focus/hover
 * so keyboard and pointer users are never raced (a11y). Also adds a visible
 * JS-only dismiss button. */
function initUndoFlash(i18n) {
  const flash = document.querySelector("[data-sc-undo-flash]");
  if (!flash) return;

  let timer = setTimeout(() => {
    flash.hidden = true;
  }, UNDO_DISMISS_MS);
  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  flash.addEventListener("focusin", cancel);
  flash.addEventListener("mouseenter", cancel);

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "button button--small button--secondary";
  dismiss.textContent = i18n.dismiss || "Dismiss";
  dismiss.addEventListener("click", () => {
    cancel();
    flash.hidden = true;
  });
  flash.append(dismiss);
}

const i18n = readI18n();
initSortable();
initAddDialog();
initSearchFilter(i18n);
initUndoFlash(i18n);
