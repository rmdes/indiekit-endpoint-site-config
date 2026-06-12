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
 * build-status.json); polling caps at 3× that — with a 30s floor so a
 * 2s-build site doesn't flip to "taking longer than usual" after one poll
 * (90s when the expected time is unknown) — then shows "taking longer than
 * usual" and leaves the manual reload button as the recovery affordance.
 * The no-JS path (plain POST + full page reloads) works without any of
 * this. */
const PREVIEW_POLL_MS = 3000;
const PREVIEW_DEFAULT_CAP_MS = 90_000;
const PREVIEW_MIN_CAP_MS = 30_000;

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
    const capMs = expected
      ? Math.max(expected * 3 * 1000, PREVIEW_MIN_CAP_MS)
      : PREVIEW_DEFAULT_CAP_MS;
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

/** (6) Publish-flow build-status strip (Phase 5 S2). After a publish
 * (?published=1) the draft bar — now "Live" — gains a strip tracking the
 * Eleventy rebuild. The strip element only renders on the publish flash;
 * sessionStorage carries the watch across reloads of that page, stamped
 * with the publish time so "finishedAt after the publish" is checkable.
 * Polling is a passive 5s GET of the authed build-status API (a cheap fs
 * read server-side); the watch ends on terminal states (post-publish ok,
 * or failed) and when the user navigates off the flash page. A stale "ok"
 * from BEFORE the publish keeps the rebuilding copy — the new build just
 * hasn't been observed yet.
 *
 * No stamp + a terminal status = a reload AFTER the watch already ended
 * (endWatch cleared the stamp; the URL still says ?published=1). The probe
 * branch handles it: fetch once FIRST and, if the status is already
 * terminal (ok with a finishedAt, or failed), render it as-is and never
 * (re)start the watch — re-stamping with the reload time would compare
 * finishedAt against the WRONG moment and replace a correct "Live · time"
 * with an eternal "Rebuilding…". Only a non-terminal probe (building,
 * unknown, fetch failure) stamps and starts polling.
 *
 * The no-JS path renders the last-known status server-side with a
 * reload-to-update note. */
const BUILD_STATUS_POLL_MS = 5000;
const BUILD_STATUS_URL = "/site-config/design/api/build-status";
const PUBLISH_WATCH_KEY = "scPublishWatch";
const BUILD_ERROR_EXCERPT_CHARS = 140;

function initBuildStatus(i18n) {
  const strip = document.querySelector("[data-sc-build-status]");
  if (!strip) {
    // The watch lives only on the page showing the publish flash —
    // navigating away ends it (a lingering stamp would poison the
    // "finishedAt after publish" check on the NEXT publish).
    sessionStorage.removeItem(PUBLISH_WATCH_KEY);
    return;
  }
  const text = strip.querySelector("[data-sc-build-text]");
  if (!text) return;

  const setText = (value) => {
    text.textContent = value;
  };

  // The moment finishedAt must beat for an "ok" to count as terminal.
  // Stamp path: the publish time. Probe path: 0 — any finished build is
  // terminal there (see the docblock above).
  let publishedAt = 0;
  let timer = null;
  let ended = false;
  const endWatch = () => {
    ended = true;
    sessionStorage.removeItem(PUBLISH_WATCH_KEY);
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const render = (status) => {
    const state = status?.state;
    if (state === "building") {
      if (status.stuck) return setText(i18n.buildStuck || "");
      const seconds =
        typeof status.lastOkDurationSeconds === "number" && status.lastOkDurationSeconds > 0
          ? Math.round(status.lastOkDurationSeconds)
          : null;
      return setText(
        seconds
          ? (i18n.buildBuilding || "").replace("{{seconds}}", String(seconds))
          : i18n.buildBuildingUnknown || "",
      );
    }
    if (state === "ok") {
      const finishedAt =
        typeof status.finishedAt === "string" ? Date.parse(status.finishedAt) : Number.NaN;
      if (!Number.isNaN(finishedAt) && finishedAt > publishedAt) {
        // Terminal: the build landed. (Client-side display only —
        // templates never see this Date.)
        setText(
          (i18n.buildLive || "").replace(
            "{{time}}",
            new Date(finishedAt).toLocaleTimeString(),
          ),
        );
        endWatch();
        return;
      }
      // Stale ok from before the publish (or finishedAt dropped): the
      // rebuild hasn't been observed yet — keep waiting.
      return setText(i18n.buildBuildingUnknown || "");
    }
    if (state === "failed") {
      const parts = [i18n.buildFailed || ""];
      if (typeof status.error === "string" && status.error !== "") {
        parts.push(status.error.slice(0, BUILD_ERROR_EXCERPT_CHARS));
      }
      parts.push(i18n.buildRetryHint || "");
      setText(parts.filter(Boolean).join(" "));
      endWatch(); // terminal: failed (the live site is unchanged)
      return;
    }
    // unknown — or any unrecognized/garbage state — renders neutral copy
    // and keeps polling (the writer may catch up).
    setText(i18n.buildUnknown || "");
  };

  const fetchStatus = async () => {
    try {
      const response = await fetch(BUILD_STATUS_URL, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return null; // transient — caller keeps polling
      return await response.json();
    } catch {
      return null; // network blip — the last rendered copy stands
    }
  };

  const tick = async () => {
    const status = await fetchStatus();
    if (status) render(status);
  };

  const stamp = Number(sessionStorage.getItem(PUBLISH_WATCH_KEY));
  if (Number.isFinite(stamp) && stamp > 0) {
    // Mid-watch reload of the flash page: keep the original publish stamp.
    publishedAt = stamp;
    timer = setInterval(tick, BUILD_STATUS_POLL_MS);
    tick();
    return;
  }

  // No stamp: a fresh publish flash, or a reload after the watch ended.
  // Probe FIRST — in probe mode (publishedAt 0) render() treats any ok
  // with a finishedAt, and any failed, as terminal: show it, never watch.
  (async () => {
    const status = await fetchStatus();
    if (status) render(status);
    if (ended) return; // already terminal — the rendered copy is final
    publishedAt = Date.now();
    sessionStorage.setItem(PUBLISH_WATCH_KEY, String(publishedAt));
    timer = setInterval(tick, BUILD_STATUS_POLL_MS);
  })();
}

const i18n = readI18n();
initSortable();
initAddDialog();
initSearchFilter(i18n);
initUndoFlash(i18n);
initPreviewPane(i18n);
initBuildStatus(i18n);
