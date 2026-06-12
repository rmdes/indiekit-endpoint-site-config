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

/** (6) Publish-flow build-status strip (Phase 5 S2, stateless). After a
 * publish the redirect carries the publish epoch in the URL
 * (?published=<Date.now() on the SERVER — the same clock that writes
 * finishedAt into build-status.json, so no client/server skew) and the
 * draft bar — now "Live" — gains a strip tracking the Eleventy rebuild.
 * The strip element only renders on the publish flash; the epoch is the
 * ONLY state, so reloads need no storage:
 *
 * - ok with finishedAt > epoch → the new build landed: "Live · time",
 *   terminal (covers reloads after the build completed — the probe sees
 *   a post-publish finishedAt immediately, no false "Rebuilding…").
 * - ok with finishedAt ≤ epoch → STALE pre-publish ok (the Eleventy
 *   watcher debounces ~5s before flipping to "building", so the very
 *   first probe after a publish always sees this): building copy + poll.
 * - failed with finishedAt > epoch → the new build failed: failed copy,
 *   terminal. failed with finishedAt ≤ epoch (or unparseable) → the LAST
 *   build failed BEFORE this publish; the publish just triggered a new
 *   one: building copy + poll.
 * - building → building copy (stuck variant keeps polling too) + poll.
 * - unknown → building copy + poll (a build is known to be coming).
 *
 * A legacy/garbage published value (e.g. "1") falls back to probe-first
 * semantics with epoch 0: any parseable terminal status renders as-is and
 * the watch never starts; only a non-terminal probe polls. Polling is a
 * passive 5s GET of the authed build-status API (a cheap fs read
 * server-side) and stops on terminal states. The no-JS path renders the
 * last-known status server-side with a reload-to-update note. */
const BUILD_STATUS_POLL_MS = 5000;
const BUILD_STATUS_URL = "/site-config/design/api/build-status";
const BUILD_ERROR_EXCERPT_CHARS = 140;
// Plausibility floor for the URL epoch: anything ≤ this (legacy "1",
// garbage, tampered values) is not a publish time. 1e12 ms ≈ 2001-09-09.
const MIN_PUBLISH_EPOCH_MS = 1e12;

function initBuildStatus(i18n) {
  const strip = document.querySelector("[data-sc-build-status]");
  if (!strip) return;
  const text = strip.querySelector("[data-sc-build-text]");
  if (!text) return;

  const setText = (value) => {
    text.textContent = value;
  };

  // The moment finishedAt must beat for a status to count as THIS
  // publish's build. Real epoch from the redirect URL, or 0 (legacy
  // probe-first semantics — any parseable terminal status wins).
  const raw = Number(new URLSearchParams(window.location.search).get("published"));
  const publishedAt =
    Number.isFinite(raw) && raw > MIN_PUBLISH_EPOCH_MS ? raw : 0;

  let timer = null;
  let ended = false;
  const endWatch = () => {
    ended = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const renderBuilding = (status) => {
    const seconds =
      typeof status?.lastOkDurationSeconds === "number" && status.lastOkDurationSeconds > 0
        ? Math.round(status.lastOkDurationSeconds)
        : null;
    setText(
      seconds
        ? (i18n.buildBuilding || "").replace("{{seconds}}", String(seconds))
        : i18n.buildBuildingUnknown || "",
    );
  };

  const render = (status) => {
    if (ended) return; // a late in-flight response must not revive the strip
    const state = status?.state;
    const finishedAt =
      typeof status?.finishedAt === "string" ? Date.parse(status.finishedAt) : Number.NaN;
    if (state === "building") {
      if (status.stuck) return setText(i18n.buildStuck || ""); // keeps polling
      return renderBuilding(status);
    }
    if (state === "ok") {
      if (!Number.isNaN(finishedAt) && finishedAt > publishedAt) {
        // Terminal: the post-publish build landed. (Client-side display
        // only — templates never see this Date.)
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
      // rebuild hasn't been observed yet — show the building copy (the
      // stale ok carries lastOkDurationSeconds, so the ~Xs estimate is
      // usually available) and keep waiting.
      return renderBuilding(status);
    }
    if (state === "failed") {
      // With a real epoch, only a POST-publish failure is terminal. A
      // stale failed (finishedAt ≤ epoch, or unparseable) means the LAST
      // build failed before this publish — the publish just triggered a
      // new build, so keep the building copy and poll on.
      if (publishedAt > 0 && !(finishedAt > publishedAt)) {
        return renderBuilding(status);
      }
      const parts = [i18n.buildFailed || ""];
      if (typeof status.error === "string" && status.error !== "") {
        parts.push(status.error.slice(0, BUILD_ERROR_EXCERPT_CHARS));
      }
      parts.push(i18n.buildRetryHint || "");
      setText(parts.filter(Boolean).join(" "));
      endWatch(); // terminal: this publish's build failed (live site unchanged)
      return;
    }
    // unknown — or any unrecognized/garbage state. With a real epoch a
    // build is known to be coming, so show the building copy; in legacy
    // probe mode keep the neutral copy. Either way keep polling (the
    // writer may catch up).
    setText(publishedAt > 0 ? i18n.buildBuildingUnknown || "" : i18n.buildUnknown || "");
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

  // Probe immediately (terminal statuses resolve without a single poll),
  // then poll every 5s until a terminal render stops the watch.
  (async () => {
    await tick();
    if (ended) return;
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
