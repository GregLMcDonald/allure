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
      { id: "cat_marche", label: "marche", color: "#F3D3DC" }, // soft blush
      { id: "cat_v1", label: "v1", color: "#D98AA3" },         // dusty rose
      { id: "cat_v2", label: "v2", color: "#9B2D4F" },         // deep wine
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
        color: typeof c.color === "string" ? c.color : "#D98AA3",
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
      `<span class="dot" style="background:${escapeAttr(cat.color)}"></span>` +
      `<span>${escapeHtml(cat.label)}</span>`;
    chip.setAttribute("aria-label", `Ajouter un segment ${cat.label}`);
    chip.addEventListener("click", () => addSegment(cat.id));
    els.categoryChips.appendChild(chip);
  });
}

// Prompt for a duration and add a segment of the given category.
function addSegment(categoryId) {
  const cat = getCategory(categoryId);
  if (!cat) return;
  const input = window.prompt(
    `Durée pour « ${cat.label} » (mm:ss ou minutes)`,
    "1:00"
  );
  if (input === null) return; // cancelled
  const seconds = parseDuration(input);
  if (!seconds) {
    showToast("Durée invalide");
    return;
  }
  state.sequence.push({ categoryId, durationSeconds: seconds });
  saveState();
  renderSequence();
}

function renderSequence() {
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

    const color = document.createElement("span");
    color.className = "seq-color";
    color.style.background = cat ? cat.color : "var(--muted)";

    const main = document.createElement("div");
    main.className = "seq-main";
    const label = document.createElement("div");
    label.className = "seq-label";
    label.textContent = cat ? cat.label : "(supprimée)";
    main.appendChild(label);

    // Editable duration field (mm:ss)
    const dur = document.createElement("input");
    dur.className = "seq-dur";
    dur.type = "text";
    dur.inputMode = "numeric";
    dur.value = formatTime(seg.durationSeconds);
    dur.setAttribute("aria-label", "Durée du segment");
    dur.addEventListener("change", () => {
      const sec = parseDuration(dur.value);
      if (sec) {
        seg.durationSeconds = sec;
        saveState();
      }
      // Re-render to normalize display (and total).
      renderSequence();
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
              color: String(c.color || "#D98AA3"),
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
  const palette = ["#F3D3DC", "#D98AA3", "#9B2D4F", "#E08A5B", "#C76B86"];
  const color = palette[state.categories.length % palette.length];
  state.categories.push({ id: uid("cat"), label: clean, color });
  saveState();
  renderChips();
  renderCategoryEditor();
}

/* ----------------------------------------------------------------------- */
/* 7. Settings & voices                                                     */
/* ----------------------------------------------------------------------- */

let availableVoices = [];

function loadVoices() {
  if (!("speechSynthesis" in window)) return;
  availableVoices = window.speechSynthesis.getVoices() || [];
  renderVoiceOptions();
}

function frenchVoices() {
  return availableVoices.filter((v) => /^fr/i.test(v.lang));
}

function renderVoiceOptions() {
  const sel = els.selectVoice;
  if (!sel) return;
  sel.innerHTML = "";

  const frVoices = frenchVoices();
  const voices = frVoices.length ? frVoices : availableVoices;

  if (voices.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "Voix par défaut du système";
    opt.value = "";
    sel.appendChild(opt);
    return;
  }

  voices.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} (${v.lang})`;
    sel.appendChild(opt);
  });

  // Default to stored voice, else first fr-* voice.
  if (state.settings.voiceURI && voices.some((v) => v.voiceURI === state.settings.voiceURI)) {
    sel.value = state.settings.voiceURI;
  } else if (frVoices.length) {
    state.settings.voiceURI = frVoices[0].voiceURI;
    sel.value = state.settings.voiceURI;
    saveState();
  }
}

function selectedVoice() {
  if (!state.settings.voiceURI) {
    const fr = frenchVoices();
    return fr.length ? fr[0] : null;
  }
  return availableVoices.find((v) => v.voiceURI === state.settings.voiceURI) || null;
}

/* ----------------------------------------------------------------------- */
/* 8. Audio / TTS                                                           */
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

  // 2) Prime speechSynthesis with a near-silent utterance so iOS lets later
  //    (background) utterances through. Empty string can be ignored, so use
  //    a space at volume 0.
  try {
    if ("speechSynthesis" in window) {
      const primer = new SpeechSynthesisUtterance(" ");
      primer.volume = 0;
      primer.lang = "fr-FR";
      window.speechSynthesis.speak(primer);
    }
  } catch (e) { /* ignore */ }

  audioUnlocked = true;
}

// Speak a phrase in French, cancelling anything already queued.
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  try {
    const synth = window.speechSynthesis;
    synth.cancel(); // never queue cues up
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "fr-FR";
    const v = selectedVoice();
    if (v) u.voice = v;
    u.rate = 1;
    u.pitch = 1;
    // Chrome can leave the engine in a "paused" state, which silently drops
    // new utterances — resume() defends against that.
    if (synth.paused) synth.resume();
    synth.speak(u);
  } catch (e) { /* ignore */ }
}

// Announce a segment: "Marche, deux minutes".
function announceSegment(seg) {
  const cat = getCategory(seg.categoryId);
  const label = cat ? cat.label : "segment";
  speak(`${label}, ${spokenDuration(seg.durationSeconds)}`);
}

// Short beep using Web Audio (for the 3-2-1 countdown).
function beep(frequency, durationMs) {
  if (!audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = frequency;
    osc.type = "sine";
    gain.gain.value = 0.0001;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    const now = audioCtx.currentTime;
    // Quick attack/decay envelope so it doesn't click.
    gain.gain.exponentialRampToValueAtTime(0.25, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);
    osc.start(now);
    osc.stop(now + durationMs / 1000 + 0.02);
  } catch (e) { /* ignore */ }
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
  loop();
}

// Set up segment at `index`. Computes the absolute end timestamp.
function beginSegment(index, announce) {
  run.index = index;
  const seg = currentSegment();
  if (!seg) return;

  run.segmentEndAt = Date.now() + seg.durationSeconds * 1000;
  run.lastBeepSecond = null;

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
      beep(whole === 1 ? 1320 : 880, 140); // higher pitch on the last beep
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

function finishRun() {
  vibrate([200, 100, 200, 100, 300]);
  speak("Bravo ! Séance terminée.");
  els.runTime.textContent = "0:00";
  stopRunInternals();
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
    loadVoices();
    els.toggleWakelock.checked = state.settings.keepScreenAwake;
    els.toggleBeeps.checked = state.settings.beeps;
    openModal(els.modalSettings);
  });
  els.selectVoice.addEventListener("change", () => {
    state.settings.voiceURI = els.selectVoice.value || null;
    saveState();
  });
  els.btnTestVoice.addEventListener("click", () => {
    // A gesture, so it's safe to speak directly.
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

  // Voices load asynchronously — listen for the event (the known gotcha).
  if ("speechSynthesis" in window) {
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }
}

/* ---- Init ---- */

function init() {
  // Set the precise circumference (in case the radius is tweaked in CSS).
  els.ringProgress.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  els.ringProgress.style.strokeDashoffset = "0";

  bindEvents();
  renderAll();
  loadVoices(); // may be empty now; onvoiceschanged will refill

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
