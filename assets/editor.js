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

/** (5) True-preview pane (Phase 5). Enhancement over the plain
 * Update-preview POST: fetch with `Accept: application/json`, then poll the
 * same-origin iframe every 3s — reload it and read the theme page's
 * `[data-preview-revision]` — until the just-written revision shows up.
 * Status copy quotes the site's measured build time (expectedSeconds from
 * build-status.json); polling caps at 3× that (90s floor when unknown),
 * then shows "taking longer than usual" and leaves the manual reload
 * button as the recovery affordance. The no-JS path (plain POST + full
 * page reloads) works without any of this. */
const PREVIEW_POLL_MS = 3000;
const PREVIEW_DEFAULT_CAP_MS = 90_000;

function initPreviewPane(i18n) {
  const form = document.querySelector("[data-sc-preview-form]");
  if (!form) return; // structural pane (or no editor) — nothing to enhance
  const pane = form.closest(".sc-design__preview");
  const status = pane.querySelector("[data-sc-preview-status]");
  const reload = pane.querySelector("[data-sc-preview-reload]");
  let timer = null;

  const getFrame = () => pane.querySelector("[data-sc-preview-frame]");

  const setStatus = (text) => {
    if (status) status.textContent = text;
  };

  const reloadFrame = (iframe) => {
    // Same-origin reload; re-assigning src is the fallback (also covers a
    // frame that never finished its first load).
    try {
      iframe.contentWindow.location.reload();
    } catch {
      iframe.src = iframe.src;
    }
  };

  /** First Update-preview on a fresh site: no token existed at render time,
   * so the iframe wasn't server-rendered — create it from the response. */
  const ensureFrame = (token) => {
    let iframe = getFrame();
    if (iframe) return iframe;
    pane.querySelector("[data-sc-preview-empty]")?.remove();
    iframe = document.createElement("iframe");
    iframe.className = "sc-preview-frame";
    iframe.setAttribute("data-sc-preview-frame", "");
    iframe.title = i18n.previewFrameTitle || "";
    iframe.src = `/preview/${encodeURIComponent(token)}/`;
    pane.append(iframe);
    return iframe;
  };

  const frameRevision = (iframe) => {
    try {
      return (
        iframe.contentDocument
          ?.querySelector("[data-preview-revision]")
          ?.getAttribute("data-preview-revision") ?? null
      );
    } catch {
      return null; // mid-load or cross-origin — keep polling
    }
  };

  const stopPolling = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const startPolling = ({ token, revision, expectedSeconds }) => {
    stopPolling();
    const iframe = ensureFrame(token);
    const expected =
      typeof expectedSeconds === "number" && expectedSeconds > 0 ? expectedSeconds : null;
    const capMs = expected ? expected * 3 * 1000 : PREVIEW_DEFAULT_CAP_MS;
    const startedAt = Date.now();
    setStatus(
      expected
        ? (i18n.previewBuilding || "").replace("{{seconds}}", String(Math.round(expected)))
        : i18n.previewBuildingUnknown || "",
    );
    timer = setInterval(() => {
      if (frameRevision(iframe) === String(revision)) {
        stopPolling();
        setStatus(i18n.previewReady || "");
        return;
      }
      if (Date.now() - startedAt > capMs) {
        stopPolling();
        setStatus(i18n.previewSlow || "");
        return;
      }
      reloadFrame(iframe);
    }, PREVIEW_POLL_MS);
  };

  if (reload) {
    reload.hidden = false;
    reload.addEventListener("click", () => {
      const iframe = getFrame();
      if (iframe) reloadFrame(iframe);
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const response = await fetch(form.action, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      startPolling(await response.json());
    } catch {
      // Fall back to the plain POST (full reload) — the no-JS path.
      stopPolling();
      form.submit();
    }
  });
}

const i18n = readI18n();
initSortable();
initAddDialog();
initSearchFilter(i18n);
initUndoFlash(i18n);
initPreviewPane(i18n);
