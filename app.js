/* =========================================================================
   Allure — running interval trainer
   Plain vanilla ES module. No framework, no build step.

   Sections:
     1. App identity & constants
     2. Storage (localStorage load/save, validation, migration)
     3. Utilities (time formatting, French spoken durations)
     4. DOM references
     5. Builder screen (chips, sequence list, presets)
     6. Category manager
     7. Settings & voices
     8. Audio / TTS (unlock, speak, beeps, vibrate)
     9. Background helpers (silent audio, MediaSession, Wake Lock)
    10. Run screen / timer engine (timestamp-based)
    11. Navigation, toast, init, service worker registration
   ========================================================================= */

"use strict";

/* ----------------------------------------------------------------------- */
/* 1. App identity & constants                                              */
/* ----------------------------------------------------------------------- */

// The app name lives here (plus index.html <title>/<h1> and manifest).
const APP_NAME = "Allure";

const STORAGE_KEY = "allure.state.v1";
const RING_RADIUS = 108;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS; // ≈ 678.58

// A unique id generator that doesn't rely on crypto (broad support).
let _idCounter = 0;
function uid(prefix) {
  _idCounter += 1;
  return prefix + "_" + Date.now().toString(36) + "_" + _idCounter.toString(36);
}

/* ----------------------------------------------------------------------- */
/* 2. Storage                                                               */
/* ----------------------------------------------------------------------- */

// Default seeded state when nothing is stored yet.
function defaultState() {
  return {
    categories: [
      { id: "cat_marche", label: "marche", color: "#4ECBA5" }, // fresh mint
      { id: "cat_v1", label: "v1", color: "#FF8A3D" },         // tangerine
      { id: "cat_v2", label: "v2", color: "#B5184C" },         // punchy wine
    ],
    sequence: [], // [{ categoryId, durationSeconds }]
    presets: [],  // [{ id, name, segments }]
    settings: {
      loop: false,
      keepScreenAwake: false,
      beeps: false,
      voiceURI: null,
    },
  };
}

// In-memory application state (the single source of truth).
let state = loadState();

function loadState() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    // localStorage can throw in private mode; fall back to defaults.
    return defaultState();
  }
  if (!raw) return defaultState();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return defaultState();
  }
  return validateState(parsed);
}

// Validate & migrate gracefully. Anything missing/wrong is repaired.
function validateState(input) {
  const base = defaultState();
  if (!input || typeof input !== "object") return base;

  const out = base;

  // Categories
  if (Array.isArray(input.categories) && input.categories.length > 0) {
    const cats = input.categories
      .filter((c) => c && typeof c === "object")
      .map((c) => ({
        id: typeof c.id === "string" ? c.id : uid("cat"),
        label: typeof c.label === "string" && c.label.trim() ? c.label : "catégorie",
        color: typeof c.color === "string" ? c.color : "#FF7A9A",
      }));
    if (cats.length) out.categories = cats;
  }

  // Helper: only keep segments that reference an existing category.
  const catIds = new Set(out.categories.map((c) => c.id));
  const cleanSegments = (segs) =>
    Array.isArray(segs)
      ? segs
          .filter((s) => s && catIds.has(s.categoryId))
          .map((s) => ({
            categoryId: s.categoryId,
            durationSeconds: clampDuration(s.durationSeconds),
          }))
      : [];

  out.sequence = cleanSegments(input.sequence);

  // Presets
  if (Array.isArray(input.presets)) {
    out.presets = input.presets
      .filter((p) => p && typeof p === "object")
      .map((p) => ({
        id: typeof p.id === "string" ? p.id : uid("preset"),
        name: typeof p.name === "string" && p.name.trim() ? p.name : "Sans nom",
        segments: cleanSegments(p.segments),
      }));
  }

  // Settings
  if (input.settings && typeof input.settings === "object") {
    out.settings = {
      loop: !!input.settings.loop,
      keepScreenAwake: !!input.settings.keepScreenAwake,
      beeps: !!input.settings.beeps,
      voiceURI:
        typeof input.settings.voiceURI === "string"
          ? input.settings.voiceURI
          : null,
    };
  }

  return out;
}

function clampDuration(sec) {
  const n = Math.round(Number(sec));
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 3600) return 3600; // cap at one hour per segment
  return n;
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    // Ignore quota/private-mode errors — app still works in-memory.
  }
}

/* ----------------------------------------------------------------------- */
/* 3. Utilities                                                             */
/* ----------------------------------------------------------------------- */

function getCategory(id) {
  return state.categories.find((c) => c.id === id) || null;
}

// Format seconds -> "m:ss" (e.g. 90 -> "1:30").
function formatTime(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ":" + String(r).padStart(2, "0");
}

// Parse a user-typed "mm:ss" string into seconds.
// Rules: "2" or "2:00" -> 120s (bare number = minutes). "0:30" -> 30s.
// "1:05" -> 65s. Tolerant of whitespace and commas.
function parseDuration(text) {
  if (text == null) return null;
  const t = String(text).trim().replace(",", ":");
  if (!t) return null;

  if (t.includes(":")) {
    const parts = t.split(":");
    const mins = parseInt(parts[0], 10) || 0;
    const secs = parseInt(parts[1], 10) || 0;
    const total = mins * 60 + secs;
    return total > 0 ? clampDuration(total) : null;
  }
  // Bare number = minutes (per spec "default interpret as minutes").
  const minutes = parseFloat(t);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return clampDuration(Math.round(minutes * 60));
}

// Convert seconds into a natural French spoken phrase.
// e.g. 120 -> "deux minutes", 30 -> "trente secondes", 90 -> "une minute trente"
function spokenDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;

  const minPart = m > 0 ? `${m} ${m === 1 ? "minute" : "minutes"}` : "";
  const secPart = r > 0 ? `${r} ${r === 1 ? "seconde" : "secondes"}` : "";

  if (m > 0 && r > 0) return `${m} ${m === 1 ? "minute" : "minutes"} ${r}`;
  if (m > 0) return minPart;
  if (r > 0) return secPart;
  return "zéro seconde";
}

function totalSequenceSeconds(segments) {
  return segments.reduce((sum, s) => sum + s.durationSeconds, 0);
}

/* ----------------------------------------------------------------------- */
/* 4. DOM references                                                        */
/* ----------------------------------------------------------------------- */

const $ = (id) => document.getElementById(id);

const els = {
  // screens
  screenBuilder: $("screen-builder"),
  screenRun: $("screen-run"),
  // builder
  categoryChips: $("category-chips"),
  sequenceList: $("sequence-list"),
  sequenceEmpty: $("sequence-empty"),
  totalDuration: $("total-duration"),
  toggleLoop: $("toggle-loop"),
  btnStart: $("btn-start"),
  btnManageCategories: $("btn-manage-categories"),
  btnOpenSettings: $("btn-open-settings"),
  // presets
  presetList: $("preset-list"),
  presetEmpty: $("preset-empty"),
  btnSavePreset: $("btn-save-preset"),
  btnExport: $("btn-export"),
  btnImport: $("btn-import"),
  fileImport: $("file-import"),
  // category modal
  modalCategories: $("modal-categories"),
  categoryEditor: $("category-editor"),
  btnAddCategory: $("btn-add-category"),
  // duration picker modal
  modalDuration: $("modal-duration"),
  durModalTitle: $("dur-modal-title"),
  durValue: $("dur-value"),
  durMinus: $("dur-minus"),
  durPlus: $("dur-plus"),
  durQuick: $("dur-quick"),
  durConfirm: $("dur-confirm"),
  // settings modal
  modalSettings: $("modal-settings"),
  selectVoice: $("select-voice"),
  btnTestVoice: $("btn-test-voice"),
  toggleWakelock: $("toggle-wakelock"),
  toggleBeeps: $("toggle-beeps"),
  // run screen
  ringProgress: $("ring-progress"),
  runTime: $("run-time"),
  runCategory: $("run-category"),
  runNext: $("run-next"),
  runProgress: $("run-progress"),
  btnStop: $("btn-stop"),
  btnPrev: $("btn-prev"),
  btnNext: $("btn-next"),
  btnPlayPause: $("btn-playpause"),
  iconPlay: $("icon-play"),
  iconPause: $("icon-pause"),
  playPauseLabel: $("playpause-label"),
  // misc
  toast: $("toast"),
};

/* ----------------------------------------------------------------------- */
/* 5. Builder screen                                                        */
/* ----------------------------------------------------------------------- */

function renderChips() {
  els.categoryChips.innerHTML = "";
  state.categories.forEach((cat) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.style.background = tint(cat.color);
    chip.innerHTML =
      `<span class="dot" style="background-color:${escapeAttr(cat.color)}"></span>` +
      `<span>${escapeHtml(cat.label)}</span>`;
    chip.setAttribute("aria-label", `Ajouter un segment ${cat.label}`);
    chip.addEventListener("click", () => addSegment(cat.id));
    els.categoryChips.appendChild(chip);
  });
}

// Pick a duration (in-app sheet, no native prompt) and add a segment.
function addSegment(categoryId) {
  const cat = getCategory(categoryId);
  if (!cat) return;
  openDurationPicker({
    title: `Durée — ${cat.label}`,
    initialSeconds: 60,
    confirmLabel: "Ajouter",
    onConfirm: (seconds) => {
      state.sequence.push({ categoryId, durationSeconds: seconds });
      saveState();
      renderSequence(state.sequence.length - 1);
    },
  });
}

/* ---- Duration picker (bottom sheet) ---- */

const DUR_STEP = 15;                            // seconds per +/- tap
const DUR_QUICKS = [30, 60, 90, 120, 180, 300]; // quick-pick presets (s)
const picker = { seconds: 60, onConfirm: null };

function clampPickerSeconds(s) {
  return Math.min(3600, Math.max(5, Math.round(s)));
}

function openDurationPicker(opts) {
  picker.seconds = clampPickerSeconds(opts.initialSeconds || 60);
  picker.onConfirm = typeof opts.onConfirm === "function" ? opts.onConfirm : null;
  els.durModalTitle.textContent = opts.title || "Durée";
  els.durConfirm.textContent = opts.confirmLabel || "OK";
  renderDurQuick();
  updateDurDisplay();
  openModal(els.modalDuration);
}

function renderDurQuick() {
  els.durQuick.innerHTML = "";
  DUR_QUICKS.forEach((sec) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dur-chip";
    b.dataset.sec = String(sec);
    b.textContent = formatTime(sec);
    b.addEventListener("click", () => {
      picker.seconds = clampPickerSeconds(sec);
      updateDurDisplay();
      vibrate(8);
    });
    els.durQuick.appendChild(b);
  });
}

function updateDurDisplay() {
  els.durValue.textContent = formatTime(picker.seconds);
  // Highlight a quick chip if it matches exactly.
  els.durQuick.querySelectorAll(".dur-chip").forEach((b) => {
    b.classList.toggle("is-active", Number(b.dataset.sec) === picker.seconds);
  });
}

function stepDuration(delta) {
  // Snap to the step grid so repeated taps stay on tidy values.
  let next;
  if (delta > 0) next = Math.floor(picker.seconds / DUR_STEP) * DUR_STEP + DUR_STEP;
  else next = Math.ceil(picker.seconds / DUR_STEP) * DUR_STEP - DUR_STEP;
  picker.seconds = clampPickerSeconds(next);
  updateDurDisplay();
  vibrate(8);
}

function confirmDuration() {
  const cb = picker.onConfirm;
  const seconds = picker.seconds;
  closeModal(els.modalDuration);
  picker.onConfirm = null;
  if (cb) cb(seconds);
}

function renderSequence(highlightIndex) {
  const list = els.sequenceList;
  list.innerHTML = "";

  const isEmpty = state.sequence.length === 0;
  els.sequenceEmpty.hidden = !isEmpty;
  els.btnStart.disabled = isEmpty;
  els.btnSavePreset.disabled = isEmpty;

  state.sequence.forEach((seg, index) => {
    const cat = getCategory(seg.categoryId);
    const li = document.createElement("li");
    li.className = "seq-item";
    if (index === highlightIndex) li.classList.add("just-added");

    const color = document.createElement("span");
    color.className = "seq-color";
    color.style.backgroundColor = cat ? cat.color : "var(--muted)";

    const main = document.createElement("div");
    main.className = "seq-main";
    const label = document.createElement("div");
    label.className = "seq-label";
    label.textContent = cat ? cat.label : "(supprimée)";
    main.appendChild(label);

    // Tappable duration — opens the in-app picker.
    const dur = document.createElement("button");
    dur.type = "button";
    dur.className = "seq-dur";
    dur.textContent = formatTime(seg.durationSeconds);
    dur.setAttribute("aria-label", `Durée du segment : ${formatTime(seg.durationSeconds)}. Toucher pour modifier.`);
    dur.addEventListener("click", () => {
      openDurationPicker({
        title: `Durée — ${cat ? cat.label : "segment"}`,
        initialSeconds: seg.durationSeconds,
        confirmLabel: "OK",
        onConfirm: (seconds) => {
          seg.durationSeconds = seconds;
          saveState();
          renderSequence();
        },
      });
    });

    const btns = document.createElement("div");
    btns.className = "seq-btns";
    btns.appendChild(miniBtn("▲", "Monter", index === 0, () => moveSegment(index, -1)));
    btns.appendChild(
      miniBtn("▼", "Descendre", index === state.sequence.length - 1, () =>
        moveSegment(index, 1)
      )
    );
    btns.appendChild(miniBtn("✕", "Supprimer", false, () => deleteSegment(index), true));

    li.appendChild(color);
    li.appendChild(main);
    li.appendChild(dur);
    li.appendChild(btns);
    list.appendChild(li);
  });

  els.totalDuration.textContent = formatTime(totalSequenceSeconds(state.sequence));
}

function miniBtn(glyph, label, disabled, onClick, danger) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mini-btn" + (danger ? " danger" : "");
  b.textContent = glyph;
  b.setAttribute("aria-label", label);
  b.disabled = !!disabled;
  if (!disabled) b.addEventListener("click", onClick);
  return b;
}

function moveSegment(index, delta) {
  const j = index + delta;
  if (j < 0 || j >= state.sequence.length) return;
  const arr = state.sequence;
  [arr[index], arr[j]] = [arr[j], arr[index]];
  saveState();
  renderSequence();
}

function deleteSegment(index) {
  state.sequence.splice(index, 1);
  saveState();
  renderSequence();
}

/* ---- Presets ---- */

function renderPresets() {
  const list = els.presetList;
  list.innerHTML = "";
  els.presetEmpty.hidden = state.presets.length !== 0;

  state.presets.forEach((preset) => {
    const li = document.createElement("li");
    li.className = "preset-item";

    const name = document.createElement("span");
    name.className = "preset-name";
    name.textContent = preset.name;

    const meta = document.createElement("span");
    meta.className = "preset-meta";
    meta.textContent =
      preset.segments.length + " · " + formatTime(totalSequenceSeconds(preset.segments));

    const loadBtn = miniBtn("↺", "Charger", false, () => loadPreset(preset.id));
    const delBtn = miniBtn("✕", "Supprimer", false, () => deletePreset(preset.id), true);

    li.appendChild(name);
    li.appendChild(meta);
    li.appendChild(loadBtn);
    li.appendChild(delBtn);
    list.appendChild(li);
  });
}

function saveCurrentAsPreset() {
  if (state.sequence.length === 0) return;
  const name = window.prompt("Nom de la séquence", "Ma séquence");
  if (name === null) return;
  const clean = name.trim() || "Sans nom";
  state.presets.push({
    id: uid("preset"),
    name: clean,
    // Deep copy so later edits to the builder don't mutate the preset.
    segments: state.sequence.map((s) => ({ ...s })),
  });
  saveState();
  renderPresets();
  showToast("Séquence enregistrée ✿");
}

function loadPreset(id) {
  const preset = state.presets.find((p) => p.id === id);
  if (!preset) return;
  state.sequence = preset.segments.map((s) => ({ ...s }));
  saveState();
  renderSequence();
  showToast("« " + preset.name + " » chargée");
}

function deletePreset(id) {
  const preset = state.presets.find((p) => p.id === id);
  if (!preset) return;
  if (!window.confirm(`Supprimer « ${preset.name} » ?`)) return;
  state.presets = state.presets.filter((p) => p.id !== id);
  saveState();
  renderPresets();
}

/* ---- Export / Import (JSON) ---- */

function exportSequences() {
  const payload = {
    app: APP_NAME,
    version: 1,
    categories: state.categories,
    presets: state.presets,
    sequence: state.sequence,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "allure-sequences.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importSequencesFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      // Merge categories (by id) and append presets.
      if (Array.isArray(data.categories)) {
        const existing = new Set(state.categories.map((c) => c.id));
        data.categories.forEach((c) => {
          if (c && typeof c.id === "string" && !existing.has(c.id)) {
            state.categories.push({
              id: c.id,
              label: String(c.label || "catégorie"),
              color: String(c.color || "#FF7A9A"),
            });
          }
        });
      }
      // Re-validate everything (drops segments with unknown categories).
      const merged = validateState({
        categories: state.categories,
        presets: (state.presets || []).concat(data.presets || []),
        sequence: data.sequence || state.sequence,
        settings: state.settings,
      });
      state = merged;
      saveState();
      renderAll();
      showToast("Importé ✿");
    } catch (e) {
      showToast("Fichier invalide");
    }
  };
  reader.readAsText(file);
}

/* ----------------------------------------------------------------------- */
/* 6. Category manager                                                      */
/* ----------------------------------------------------------------------- */

function renderCategoryEditor() {
  const box = els.categoryEditor;
  box.innerHTML = "";

  state.categories.forEach((cat) => {
    const row = document.createElement("div");
    row.className = "cat-row";

    const color = document.createElement("input");
    color.type = "color";
    color.value = normalizeHex(cat.color);
    color.setAttribute("aria-label", "Couleur de " + cat.label);
    color.addEventListener("input", () => {
      cat.color = color.value;
      saveState();
      renderChips();
      renderSequence();
    });

    const label = document.createElement("input");
    label.type = "text";
    label.value = cat.label;
    label.setAttribute("aria-label", "Nom de la catégorie");
    label.addEventListener("change", () => {
      const v = label.value.trim();
      cat.label = v || cat.label;
      label.value = cat.label;
      saveState();
      renderChips();
      renderSequence();
    });

    const del = miniBtn("✕", "Supprimer la catégorie", false, () => {
      if (!window.confirm(`Supprimer la catégorie « ${cat.label} » ?`)) return;
      state.categories = state.categories.filter((c) => c.id !== cat.id);
      // Drop any sequence/preset segments that used it.
      state.sequence = state.sequence.filter((s) => s.categoryId !== cat.id);
      state.presets.forEach((p) => {
        p.segments = p.segments.filter((s) => s.categoryId !== cat.id);
      });
      saveState();
      renderAll();
      renderCategoryEditor();
    }, true);

    row.appendChild(color);
    row.appendChild(label);
    row.appendChild(del);
    box.appendChild(row);
  });
}

function addCategory() {
  const label = window.prompt("Nom de la nouvelle catégorie", "");
  if (label === null) return;
  const clean = label.trim();
  if (!clean) return;
  // Pick a default color from the rose ramp, rotating through it.
  const palette = ["#FF7A9A", "#FF8A3D", "#FFC15E", "#4ECBA5", "#B5184C", "#B05CFF"];
  const color = palette[state.categories.length % palette.length];
  state.categories.push({ id: uid("cat"), label: clean, color });
  saveState();
  renderChips();
  renderCategoryEditor();
}

/* ----------------------------------------------------------------------- */
/* 7. Audio / TTS                                                           */
/* ----------------------------------------------------------------------- */

let audioCtx = null;       // shared Web Audio context
let audioUnlocked = false; // true once unlocked by a user gesture (iOS)

// Must be called from within a user gesture (the first "Démarrer" tap).
function unlockAudio() {
  // 1) Web Audio context (used for silent keep-alive + beeps).
  try {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  } catch (e) { /* ignore */ }

  // 2) Prime speechSynthesis once with a normal-volume (but content-free)
  //    utterance so iOS unlocks audio for later announcements. A volume-0
  //    primer does NOT reliably unlock on iOS — use the default volume, like
  //    a plain `speak(" ")`. Guarded so we only prime once.
  try {
    if ("speechSynthesis" in window && !audioUnlocked) {
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(" "));
    }
  } catch (e) { /* ignore */ }

  audioUnlocked = true;
}

// --- Voices ------------------------------------------------------------- //
// A French voice is picked automatically (so the accent is right), but the
// user can override it in Réglages. The auto-pick scores voices to favour the
// pleasant built-in French voices (Amélie, Thomas…) and avoid the novelty
// ones macOS now ships in French (Eddy, Flo, Reed, Rocko…).
let _voices = [];

// Known-good French voice names, best first.
const PREFERRED_VOICES = [
  "amélie", "amelie", "thomas", "aurélie", "aurelie", "audrey", "virginie",
  "marie", "google français", "google francais",
];
// Novelty / low-quality voice names to push to the bottom.
const NOVELTY_VOICES = [
  "eddy", "flo", "grandma", "grandpa", "reed", "rocko", "sandy", "shelley",
  "bahh", "bells", "boing", "bubbles", "cellos", "jester", "organ",
  "superstar", "trinoids", "wobble", "whisper", "zarvox", "albert",
  "junior", "ralph", "fred", "bruce", "kathy", "bad news", "good news",
];

function loadVoices() {
  if (!("speechSynthesis" in window)) return;
  _voices = window.speechSynthesis.getVoices() || [];
}

// Higher score = nicer voice.
//
// LOCAL voices are weighted very heavily: a remote / not-yet-downloaded voice
// (e.g. "Google français", some "Premium"/"Enhanced" voices) can queue in
// Chrome but NEVER start speaking — silent failure. So we only ever fall back
// to a network voice if no local French voice exists at all.
function voiceScore(v) {
  const name = (v.name || "").toLowerCase();
  let s = 0;
  if (v.localService) s += 1000; // local = reliable + offline; always preferred
  const pref = PREFERRED_VOICES.findIndex((n) => name.includes(n));
  if (pref !== -1) s += 30 - pref; // earlier in the list scores higher
  if (NOVELTY_VOICES.some((n) => name.includes(n))) s -= 100;
  return s;
}

// All French voices, nicest first.
function frenchVoices() {
  if (!_voices.length) loadVoices();
  return _voices
    .filter((v) => /^fr/i.test(v.lang))
    .sort((a, b) => voiceScore(b) - voiceScore(a));
}

// The voice to actually speak with: the user's saved choice if still present,
// otherwise the best-scoring French voice. null => browser default.
function selectedVoice() {
  if (!_voices.length) loadVoices();
  if (state.settings.voiceURI) {
    const chosen = _voices.find((v) => v.voiceURI === state.settings.voiceURI);
    if (chosen) return chosen;
  }
  const fr = frenchVoices();
  return fr.length ? fr[0] : null;
}

// Populate the Réglages dropdown (French voices, nicest first).
function renderVoiceOptions() {
  const sel = els.selectVoice;
  if (!sel) return;
  loadVoices();
  const fr = frenchVoices();
  sel.innerHTML = "";

  if (!fr.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Voix par défaut du système";
    sel.appendChild(opt);
    return;
  }

  fr.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v.voiceURI;
    opt.textContent = v.name + " (" + v.lang + ")" + (v.localService ? "" : " · réseau");
    sel.appendChild(opt);
  });

  const current = selectedVoice();
  if (current) sel.value = current.voiceURI;
}

// Hold references to in-flight utterances. THIS IS THE KEY CHROME FIX: Chrome
// (notably on macOS) garbage-collects a SpeechSynthesisUtterance that nothing
// references, cutting it off mid-speech or never starting it — total silence.
// Safari/Android don't have this bug. Keeping the object alive until it ends
// is what makes TTS work in Chrome.
const _utterances = [];

// Has the speech engine EVER actually started an utterance? Used to detect a
// browser whose TTS is wedged (e.g. some macOS Chrome installs queue
// utterances but never fire `onstart`) so we can hint the user once.
let _speechEverStarted = false;
let _speechWarned = false;

// Speak a phrase in French, cancelling anything already queued.
// `useVoice` lets us retry without a specific voice if assigning one fails
// (assigning `.voice` can fail silently on iOS Safari).
function speak(text, useVoice) {
  if (!("speechSynthesis" in window)) return;
  if (useVoice === undefined) useVoice = true;
  try {
    const synth = window.speechSynthesis;
    synth.cancel(); // never queue cues up

    const u = new SpeechSynthesisUtterance(text);
    u.lang = "fr-FR";
    u.rate = 1;

    const v = useVoice ? selectedVoice() : null;
    if (v) u.voice = v;

    // Keep a reference (Chrome GC fix); drop it when the utterance settles.
    _utterances.push(u);
    const release = () => {
      const i = _utterances.indexOf(u);
      if (i !== -1) _utterances.splice(i, 1);
    };
    let started = false;
    u.onstart = () => { started = true; _speechEverStarted = true; };
    u.onend = release;
    u.onerror = (e) => {
      release();
      const err = e && e.error;
      // "interrupted"/"canceled" fire whenever we cancel() for the next
      // segment — those are normal. A real failure with a voice set: retry
      // once with no voice (covers the iOS-Safari ".voice fails silently" case).
      if (useVoice && err && err !== "interrupted" && err !== "canceled") {
        speak(text, false);
      }
    };

    // Chrome can leave the engine "paused", which silently drops utterances.
    if (synth.paused) synth.resume();
    synth.speak(u);
    // Some Chrome builds initialise the queue paused-but-reporting-false;
    // an unconditional nudge helps those (harmless elsewhere).
    synth.resume();

    // Watchdog: a chosen voice that never actually starts (a remote/undownloaded
    // voice can queue but stay silent in Chrome, with NO error) → retry once
    // with the browser default voice. The retry passes useVoice=false, so it
    // neither re-arms this watchdog nor loops.
    if (useVoice && v) {
      setTimeout(() => {
        if (!started) speak(text, false);
      }, 700);
    }
  } catch (e) { /* ignore */ }
}

// If speech never actually starts shortly after a run begins, the browser's
// TTS is likely wedged (notably some macOS Chrome installs). Tell the user
// once that the beep/vibration cues are carrying the load.
function maybeWarnNoSpeech() {
  if (!("speechSynthesis" in window) || _speechWarned) return;
  setTimeout(() => {
    if (!_speechEverStarted && !_speechWarned) {
      _speechWarned = true;
      showToast("Voix muette dans ce navigateur — active les bips. (Safari fonctionne.)");
    }
  }, 2000);
}

// Announce a segment: "Marche, deux minutes".
function announceSegment(seg) {
  const cat = getCategory(seg.categoryId);
  const label = cat ? cat.label : "segment";
  speak(`${label}, ${spokenDuration(seg.durationSeconds)}`);
}

// Play a single soft tone with a smooth attack/decay envelope (no clicks).
// `offsetSec` schedules it relative to "now" so chimes can be sequenced.
function tone(freq, offsetSec, durSec, peak, type) {
  if (!audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type || "sine";
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    const t0 = audioCtx.currentTime + (offsetSec || 0);
    const p = peak || 0.2;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(p, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durSec);
    osc.start(t0);
    osc.stop(t0 + durSec + 0.03);
  } catch (e) { /* ignore */ }
}

// 3-2-1 countdown blip. The final tick is higher & a touch longer.
function countdownTick(isLast) {
  tone(isLast ? 1174.7 : 740, 0, isLast ? 0.2 : 0.13, isLast ? 0.24 : 0.16);
}

// Two-note rising carillon at a segment transition (gated by the Sons toggle).
function chimeTransition() {
  if (!state.settings.beeps) return;
  tone(587.33, 0, 0.16, 0.18, "sine");   // D5
  tone(880.0, 0.1, 0.24, 0.18, "sine");  // A5
}

// Cheerful ascending arpeggio for "séance terminée" (gated by the Sons toggle).
function chimeFinish() {
  if (!state.settings.beeps) return;
  const notes = [
    [523.25, 0.0, 0.22],   // C5
    [659.25, 0.13, 0.22],  // E5
    [783.99, 0.26, 0.22],  // G5
    [1046.5, 0.4, 0.5],    // C6 (held)
  ];
  notes.forEach(([f, o, d]) => tone(f, o, d, 0.2, "triangle"));
}

function vibrate(pattern) {
  try {
    if ("vibrate" in navigator) navigator.vibrate(pattern);
  } catch (e) { /* ignore */ }
}

/* ----------------------------------------------------------------------- */
/* 9. Background helpers (silent audio, MediaSession, Wake Lock)            */
/* ----------------------------------------------------------------------- */

let silentSource = null; // looping near-silent buffer source

// Start a looping near-silent buffer to keep the audio session alive while a
// run is active. This reduces the chance the tab is suspended in the
// background. (Best-effort — see README for platform limits.)
function startSilentAudio() {
  if (!audioCtx) return;
  if (silentSource) return;
  try {
    const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate, audioCtx.sampleRate);
    // Fill with an extremely low-amplitude DC-ish signal (effectively silent).
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = 0.0001 * Math.sin(i / 50);
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const gain = audioCtx.createGain();
    gain.gain.value = 0.005; // barely audible; keeps session anchored
    src.connect(gain);
    gain.connect(audioCtx.destination);
    src.start(0);
    silentSource = src;
  } catch (e) { /* ignore */ }
}

function stopSilentAudio() {
  if (silentSource) {
    try { silentSource.stop(); } catch (e) { /* ignore */ }
    silentSource = null;
  }
}

// MediaSession: surface OS media controls + wire them to our transport.
function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.setActionHandler("play", () => resumeRun());
    navigator.mediaSession.setActionHandler("pause", () => pauseRun());
    navigator.mediaSession.setActionHandler("nexttrack", () => skipNext());
    navigator.mediaSession.setActionHandler("previoustrack", () => skipPrev());
  } catch (e) { /* some actions unsupported — ignore */ }
}

function updateMediaSessionMetadata() {
  if (!("mediaSession" in navigator) || !window.MediaMetadata) return;
  const seg = currentSegment();
  const cat = seg ? getCategory(seg.categoryId) : null;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: cat ? cat.label : APP_NAME,
      artist: APP_NAME,
      album: `Segment ${run.index + 1} / ${run.segments.length}`,
    });
    navigator.mediaSession.playbackState = run.paused ? "paused" : "playing";
  } catch (e) { /* ignore */ }
}

/* ---- Wake Lock ---- */
let wakeLock = null;

async function acquireWakeLock() {
  if (!state.settings.keepScreenAwake) return;
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch (e) { /* user agent may reject — ignore */ }
}

async function releaseWakeLock() {
  if (wakeLock) {
    try { await wakeLock.release(); } catch (e) { /* ignore */ }
    wakeLock = null;
  }
}

// Re-acquire the wake lock when returning to the page (it's dropped on hide).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (run.active && !run.paused) acquireWakeLock();
    // Resume audio context if the browser suspended it.
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  }
});

/* ----------------------------------------------------------------------- */
/* 10. Run screen / timer engine (timestamp-based)                          */
/* ----------------------------------------------------------------------- */

// The run state. Timing is derived from absolute timestamps so the countdown
// self-corrects after any background throttling — we never count ticks.
const run = {
  active: false,
  paused: false,
  segments: [],        // snapshot of the sequence at start (deep-copied)
  index: 0,            // current segment index
  segmentEndAt: 0,     // Date.now() ms when the current segment ends
  remainingWhenPaused: 0, // ms remaining, captured on pause
  loop: false,
  rafId: null,
  lastBeepSecond: null, // guards 3-2-1 beeps from firing twice
  lastPulseSecond: null, // guards the ring/time "tick" bloom from firing twice
};

function currentSegment() {
  return run.segments[run.index] || null;
}

function startRun() {
  if (state.sequence.length === 0) return;

  // Unlock audio within this user gesture (critical for iOS).
  unlockAudio();
  startSilentAudio();
  setupMediaSession();
  acquireWakeLock();

  run.active = true;
  run.paused = false;
  run.loop = state.settings.loop;
  run.segments = state.sequence.map((s) => ({ ...s }));
  run.index = 0;

  showScreen("run");
  beginSegment(0, /*announce*/ true);
  maybeWarnNoSpeech(); // hint once if this browser's TTS is wedged
  loop();
}

// Set up segment at `index`. Computes the absolute end timestamp.
function beginSegment(index, announce) {
  run.index = index;
  const seg = currentSegment();
  if (!seg) return;

  run.segmentEndAt = Date.now() + seg.durationSeconds * 1000;
  run.lastBeepSecond = null;
  run.lastPulseSecond = null;

  // Visuals
  const cat = getCategory(seg.categoryId);
  els.runCategory.textContent = cat ? cat.label : "segment";
  els.runProgress.textContent = `${index + 1} / ${run.segments.length}`;

  // Next-segment hint
  const next = nextSegmentLabel();
  els.runNext.textContent = next ? `Suivant : ${next}` : "Dernier segment";

  updateMediaSessionMetadata();

  // Cues
  if (announce) {
    vibrate([120, 60, 120]);
    chimeTransition();
    announceSegment(seg);
  }

  // Initial paint so the number doesn't show stale text for a frame.
  paint();
}

function nextSegmentLabel() {
  let ni = run.index + 1;
  if (ni >= run.segments.length) {
    if (run.loop) ni = 0;
    else return null;
  }
  const seg = run.segments[ni];
  const cat = seg ? getCategory(seg.categoryId) : null;
  return cat ? cat.label : null;
}

// Main loop — uses requestAnimationFrame but derives everything from clocks.
function loop() {
  paint();
  run.rafId = requestAnimationFrame(loop);
}

function paint() {
  if (!run.active) return;
  const seg = currentSegment();
  if (!seg) return;

  let remainingMs;
  if (run.paused) {
    remainingMs = run.remainingWhenPaused;
  } else {
    remainingMs = run.segmentEndAt - Date.now();
  }

  if (remainingMs <= 0 && !run.paused) {
    advanceSegment();
    return;
  }

  const remainingSec = Math.max(0, remainingMs / 1000);
  const displaySec = Math.ceil(remainingSec);
  els.runTime.textContent = formatTime(displaySec);

  // Heartbeat: a quick ring + number bloom on each whole-second tick.
  if (!run.paused && displaySec !== run.lastPulseSecond) {
    run.lastPulseSecond = displaySec;
    pulseTick();
  }

  // Progress ring: fraction elapsed -> dashoffset.
  const total = seg.durationSeconds;
  const fraction = Math.min(1, Math.max(0, (total - remainingSec) / total));
  const offset = RING_CIRCUMFERENCE * fraction;
  els.ringProgress.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  els.ringProgress.style.strokeDashoffset = String(offset);

  // 3-2-1 beeps in the final seconds (if enabled).
  if (state.settings.beeps && !run.paused) {
    const whole = Math.ceil(remainingSec);
    if (whole <= 3 && whole >= 1 && whole !== run.lastBeepSecond) {
      run.lastBeepSecond = whole;
      countdownTick(whole === 1);
    }
  }
}

function advanceSegment() {
  const last = run.segments.length - 1;
  if (run.index < last) {
    beginSegment(run.index + 1, true);
  } else if (run.loop) {
    beginSegment(0, true);
  } else {
    finishRun();
  }
}

// Re-trigger the one-shot "tick" bloom on the ring + countdown number.
// Removing the class and forcing a reflow restarts the CSS animation.
function pulseTick() {
  [els.ringProgress, els.runTime].forEach((el) => {
    if (!el) return;
    el.classList.remove("tick");
    void el.offsetWidth; // force reflow so the animation can replay
    el.classList.add("tick");
  });
}

// Confetti-style burst of petals for the completion celebration.
function celebrate() {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  const layer = document.createElement("div");
  layer.className = "celebrate";
  layer.setAttribute("aria-hidden", "true");

  const glyphs = ["✿", "❀", "✾", "❁", "🌸"];
  const colors = ["var(--rose)", "var(--accent)", "var(--gold)", "var(--primary)", "var(--mint)"];
  const COUNT = 28;
  for (let i = 0; i < COUNT; i++) {
    const p = document.createElement("span");
    p.className = "petal";
    p.textContent = glyphs[i % glyphs.length];
    // Spread across the width; vary fall speed, drift, spin, size, and delay.
    const left = (i / COUNT) * 100 + (i * 37) % 9;
    const fall = 2.2 + ((i * 13) % 18) / 10;        // 2.2–4.0s
    const drift = ((i * 53) % 160) - 80;            // -80–80px
    const spin = 360 + ((i * 71) % 5) * 180;        // 360–1080deg
    const size = 18 + ((i * 17) % 16);              // 18–34px
    const delay = ((i * 29) % 10) / 10;             // 0–0.9s
    p.style.left = left + "%";
    p.style.color = colors[i % colors.length];
    p.style.fontSize = size + "px";
    p.style.setProperty("--fall", fall + "s");
    p.style.setProperty("--drift", drift + "px");
    p.style.setProperty("--spin", spin + "deg");
    p.style.animationDelay = delay + "s";
    layer.appendChild(p);
  }
  document.body.appendChild(layer);
  // Clean up once the slowest petal has landed.
  setTimeout(() => layer.remove(), 5200);
}

function finishRun() {
  vibrate([200, 100, 200, 100, 300]);
  chimeFinish();
  speak("Bravo ! Séance terminée.");
  els.runTime.textContent = "0:00";
  stopRunInternals();
  celebrate();
  showToast("Bravo ! ✿");
  showScreen("builder");
}

// Tear down timers/locks/audio but keep speech (the finish cue) alive.
function stopRunInternals() {
  run.active = false;
  run.paused = false;
  if (run.rafId) cancelAnimationFrame(run.rafId);
  run.rafId = null;
  stopSilentAudio();
  releaseWakeLock();
  if ("mediaSession" in navigator) {
    try { navigator.mediaSession.playbackState = "none"; } catch (e) {}
  }
}

/* ---- Transport controls ---- */

function pauseRun() {
  if (!run.active || run.paused) return;
  run.paused = true;
  run.remainingWhenPaused = Math.max(0, run.segmentEndAt - Date.now());
  els.screenRun.classList.add("is-paused");
  setPlayPauseUI(true);
  updateMediaSessionMetadata();
  // Pause spoken cues too.
  try { window.speechSynthesis.pause(); } catch (e) {}
}

function resumeRun() {
  if (!run.active || !run.paused) return;
  run.paused = false;
  // Recompute the absolute end from the captured remaining time.
  run.segmentEndAt = Date.now() + run.remainingWhenPaused;
  els.screenRun.classList.remove("is-paused");
  setPlayPauseUI(false);
  updateMediaSessionMetadata();
  acquireWakeLock();
  try { window.speechSynthesis.resume(); } catch (e) {}
}

function togglePlayPause() {
  if (run.paused) resumeRun();
  else pauseRun();
}

function setPlayPauseUI(isPaused) {
  // When paused, show the play (resume) glyph; when running, show pause.
  els.iconPlay.hidden = !isPaused;
  els.iconPause.hidden = isPaused;
  els.playPauseLabel.textContent = isPaused ? "Reprendre" : "Pause";
  els.btnPlayPause.setAttribute("aria-label", isPaused ? "Reprendre" : "Pause");
}

function skipNext() {
  if (!run.active) return;
  const last = run.segments.length - 1;
  if (run.index < last) {
    if (run.paused) resumeRun();
    beginSegment(run.index + 1, true);
  } else if (run.loop) {
    if (run.paused) resumeRun();
    beginSegment(0, true);
  } else {
    finishRun();
  }
}

function skipPrev() {
  if (!run.active) return;
  // If we're more than 2s into the segment, restart it; otherwise go back one.
  const seg = currentSegment();
  const elapsedMs = seg ? seg.durationSeconds * 1000 - (run.segmentEndAt - Date.now()) : 0;
  if (run.paused) resumeRun();
  if (elapsedMs > 2000 || run.index === 0) {
    beginSegment(run.index, true);
  } else {
    beginSegment(run.index - 1, true);
  }
}

function stopRun() {
  stopRunInternals();
  try { window.speechSynthesis.cancel(); } catch (e) {}
  showScreen("builder");
}

/* ----------------------------------------------------------------------- */
/* 11. Navigation, toast, helpers, init                                     */
/* ----------------------------------------------------------------------- */

function showScreen(name) {
  const isRun = name === "run";
  els.screenRun.hidden = !isRun;
  els.screenBuilder.hidden = isRun;
  els.screenBuilder.classList.toggle("is-active", !isRun);
  els.screenRun.classList.toggle("is-active", isRun);
  els.screenRun.classList.remove("is-paused");
  if (isRun) setPlayPauseUI(false);
  window.scrollTo(0, 0);
}

function openModal(modal) {
  modal.hidden = false;
}
function closeModal(modal) {
  modal.hidden = true;
}

let toastTimer = null;
function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2200);
}

/* ---- Small string/colour helpers ---- */

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

// Make a light tinted background from a hex colour for the chip body.
function tint(hex) {
  const c = normalizeHex(hex);
  const r = parseInt(c.slice(1, 3), 16);
  const g = parseInt(c.slice(3, 5), 16);
  const b = parseInt(c.slice(5, 7), 16);
  // Mix ~78% toward white for a soft pastel chip.
  const mix = (v) => Math.round(v + (255 - v) * 0.78);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

// Ensure a valid #rrggbb string for <input type=color>.
function normalizeHex(hex) {
  if (typeof hex !== "string") return "#d98aa3";
  let h = hex.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(h)) {
    h = "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  }
  if (/^#[0-9a-fA-F]{6}$/.test(h)) return h.toLowerCase();
  return "#d98aa3";
}

function renderAll() {
  renderChips();
  renderSequence();
  renderPresets();
}

/* ---- Wire up events ---- */

function bindEvents() {
  // Loop toggle
  els.toggleLoop.checked = state.settings.loop;
  els.toggleLoop.addEventListener("change", () => {
    state.settings.loop = els.toggleLoop.checked;
    saveState();
  });

  // Start
  els.btnStart.addEventListener("click", startRun);

  // Category manager
  els.btnManageCategories.addEventListener("click", () => {
    renderCategoryEditor();
    openModal(els.modalCategories);
  });
  els.btnAddCategory.addEventListener("click", addCategory);

  // Settings
  els.btnOpenSettings.addEventListener("click", () => {
    renderVoiceOptions();
    els.toggleWakelock.checked = state.settings.keepScreenAwake;
    els.toggleBeeps.checked = state.settings.beeps;
    openModal(els.modalSettings);
  });
  els.selectVoice.addEventListener("change", () => {
    state.settings.voiceURI = els.selectVoice.value || null;
    saveState();
    // Preview the chosen voice (this change is a user gesture).
    unlockAudio();
    speak("Bonjour, on y va à ton rythme.");
  });
  els.btnTestVoice.addEventListener("click", () => {
    // A user gesture, so it's safe to speak directly.
    unlockAudio();
    speak("Bonjour, on y va à ton rythme.");
  });
  els.toggleWakelock.addEventListener("change", () => {
    state.settings.keepScreenAwake = els.toggleWakelock.checked;
    saveState();
    if (state.settings.keepScreenAwake && run.active && !run.paused) acquireWakeLock();
    if (!state.settings.keepScreenAwake) releaseWakeLock();
  });
  els.toggleBeeps.addEventListener("change", () => {
    state.settings.beeps = els.toggleBeeps.checked;
    saveState();
  });

  // Presets
  els.btnSavePreset.addEventListener("click", saveCurrentAsPreset);
  els.btnExport.addEventListener("click", exportSequences);
  els.btnImport.addEventListener("click", () => els.fileImport.click());
  els.fileImport.addEventListener("change", () => {
    const file = els.fileImport.files && els.fileImport.files[0];
    if (file) importSequencesFromFile(file);
    els.fileImport.value = ""; // allow re-importing same file
  });

  // Duration picker
  els.durMinus.addEventListener("click", () => stepDuration(-DUR_STEP));
  els.durPlus.addEventListener("click", () => stepDuration(DUR_STEP));
  els.durConfirm.addEventListener("click", confirmDuration);

  // Run transport
  els.btnPlayPause.addEventListener("click", togglePlayPause);
  els.btnNext.addEventListener("click", skipNext);
  els.btnPrev.addEventListener("click", skipPrev);
  els.btnStop.addEventListener("click", stopRun);

  // Modal close buttons + backdrop click
  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const modal = btn.closest(".modal");
      if (modal) closeModal(modal);
    });
  });
  document.querySelectorAll(".modal").forEach((modal) => {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal(modal); // click on backdrop
    });
  });

  // Voices load asynchronously in Chrome — refresh our list when they arrive,
  // and repopulate the dropdown if the user has Réglages open.
  if ("speechSynthesis" in window) {
    window.speechSynthesis.onvoiceschanged = () => {
      loadVoices();
      if (!els.modalSettings.hidden) renderVoiceOptions();
    };
  }
}

/* ---- Init ---- */

function init() {
  // Set the precise circumference (in case the radius is tweaked in CSS).
  els.ringProgress.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  els.ringProgress.style.strokeDashoffset = "0";

  bindEvents();
  renderAll();
  loadVoices(); // may be empty now; onvoiceschanged refills it in Chrome

  // Register the service worker with a RELATIVE path so it works under a
  // GitHub Pages subpath (e.g. /allure/).
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {
        /* offline support unavailable — app still works online */
      });
    });
  }
}

init();
