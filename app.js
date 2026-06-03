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

// Material Symbols "timer" (stopwatch) glyph — used to label presentational
// durations (viewBox 0 -960 960 960, fill via currentColor).
const STOPWATCH_PATH =
  '<path fill="currentColor" d="M360-840v-80h240v80H360Zm80 440h80v-240h-80v240Zm40 320q-75 0-140.5-28.5t-114-77q-48.5-48.5-77-114T120-440q0-75 28.5-140.5t77-114q48.5-48.5 114-77T480-800q63 0 121 20t107 58l56-56 56 56-56 56q38 49 58 107t20 121q0 75-28.5 140.5t-77 114q-48.5 48.5-114 77T480-80Zm0-80q116 0 198-82t82-198q0-116-82-198t-198-82q-116 0-198 82t-82 198q0 116 82 198t198 82Zm0-280Z"/>';
const RING_RADIUS = 108;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS; // ≈ 678.58

/* ----------------------------------------------------------------------- */
/* Song library — each is a chord progression + arrangement in the         */
/* rhythmic-stab style. A category points at one of these; the music       */
/* switches when the run moves to a segment of that category. Each song    */
/* carries a default BPM (user-overridable per song in Settings).          */
/* Defined up here so loadState()/validateState() can reference it.        */
/* stab = 16th-note steps that fire a chord stab; bassMod/arpMod = play on  */
/* every Nth 16th; prog bars = { bass(Hz), triad:[Hz,Hz,Hz] }.             */
/* ----------------------------------------------------------------------- */
const SONGS = [
  {
    // Bright pop — syncopated OFFBEAT stabs over a relentless eighth bass.
    id: "lever", name: "Lever du jour", defBpm: 124, stabWave: "sawtooth",
    stab: [2, 6, 10, 14], bassMod: 2, arpMod: 2, shaker: true, clap: false,
    prog: [ // C–G–Am–F  (I–V–vi–IV, major)
      { bass: 65.41,  triad: [261.63, 329.63, 392.00] }, // C
      { bass: 98.00,  triad: [196.00, 246.94, 293.66] }, // G
      { bass: 110.00, triad: [220.00, 261.63, 329.63] }, // Am
      { bass: 87.31,  triad: [174.61, 220.00, 261.63] }, // F
    ],
  },
  {
    // Driving four-on-the-floor — ON-beat stabs + backbeat clap, anthemic minor.
    id: "asphalte", name: "Asphalte", defBpm: 144, stabWave: "sawtooth",
    stab: [0, 4, 8, 12], bassMod: 2, arpMod: 0, shaker: true, clap: true,
    prog: [ // Em–C–G–D  (i–VI–III–VII, E minor)
      { bass: 82.41, triad: [196.00, 246.94, 329.63] }, // Em (G B E)
      { bass: 65.41, triad: [261.63, 329.63, 392.00] }, // C
      { bass: 98.00, triad: [196.00, 246.94, 293.66] }, // G
      { bass: 73.42, triad: [220.00, 293.66, 369.99] }, // D (A D F#)
    ],
  },
  {
    // Synthwave — fast SIXTEENTH arp lead, sparse stabs, spacious quarter bass.
    id: "neon", name: "Néon", defBpm: 112, stabWave: "square",
    stab: [0, 8], bassMod: 4, arpMod: 1, shaker: false, clap: false,
    prog: [ // Cm–A♭–E♭–B♭  (moody minor)
      { bass: 65.41,  triad: [261.63, 311.13, 392.00] }, // Cm
      { bass: 103.83, triad: [207.65, 261.63, 311.13] }, // Ab
      { bass: 77.78,  triad: [311.13, 392.00, 466.16] }, // Eb
      { bass: 116.54, triad: [233.08, 293.66, 349.23] }, // Bb
    ],
  },
  {
    // Calm recovery — sparse half-note stabs, slow, no percussion.
    id: "recup", name: "Récup", defBpm: 92, stabWave: "triangle",
    stab: [0, 8], bassMod: 4, arpMod: 4, shaker: false, clap: false,
    prog: [ // Cmaj7–Fmaj7  (mellow)
      { bass: 65.41, triad: [329.63, 392.00, 493.88] }, // Cmaj7 (E G B)
      { bass: 87.31, triad: [220.00, 261.63, 329.63] }, // Fmaj7 (A C E)
    ],
  },
];
const SONG_IDS = SONGS.map((s) => s.id);
function getSong(id) { return SONGS.find((s) => s.id === id) || null; }

// Tempo (BPM) is a single per-category value that governs BOTH that category's
// song playback AND its metronome cadence, so they stay in sync. One unified
// range covers slow walking music up to a brisk running cadence.
const TEMPO_MIN = 80;
const TEMPO_MAX = 200;
function clampTempo(b) {
  const n = Math.round(Number(b));
  if (!Number.isFinite(n)) return 160;
  return Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, n));
}
// A sensible starting tempo for a category: its song's natural BPM, or a
// typical running cadence when there's no song.
function defaultTempoForSong(songId) {
  const s = getSong(songId);
  return clampTempo(s ? s.defBpm : 160);
}

// Clamp a block repeat count. 0 is the ∞ (loop-forever) sentinel; otherwise
// an integer in 1..99. Anything bogus falls back to 1 (plays once).
function clampRepeat(n) {
  if (n === 0) return 0; // ∞ sentinel
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(99, v);
}

function makeBlock(segments, repeat, name) {
  return {
    id: uid("blk"),
    name: typeof name === "string" ? name : "",
    repeat: clampRepeat(repeat),
    segments: segments || [],
  };
}

// Trim a block name; fall back to "Bloc N" (1-based index) when unnamed.
function blockDisplayName(block, index) {
  const n = (block.name || "").trim();
  return n || `Bloc ${index + 1}`;
}

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
    // Each category carries its own song + tempo. The tempo drives both the
    // song and the metronome for that category (see clampTempo above).
    categories: [
      { id: "cat_marche", label: "marche", color: "#4ECBA5", song: "recup", tempo: 92 },     // fresh mint
      { id: "cat_v1", label: "v1", color: "#FF8A3D", song: "lever", tempo: 124 },            // tangerine
      { id: "cat_v2", label: "v2", color: "#B5184C", song: "asphalte", tempo: 144 },         // punchy wine
    ],
    // A workout is an ordered list of blocks. Each block is a little
    // subsequence of segments with its own repeat count:
    //   repeat = 1   → plays once
    //   repeat = N   → plays N times in a row
    //   repeat = 0   → ∞, loops forever (replaces the old global "Boucle")
    blocks: [], // [{ id, name, repeat, segments: [{ categoryId, durationSeconds }] }]
    activeBlockId: null, // which block new segments get added to (builder)
    presets: [],  // [{ id, name, blocks }]
    settings: {
      keepScreenAwake: false,
      beeps: false,
      voiceURI: null,
      soundscape: "none", // none | music | cadence | both (tempo is per-category)
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
      .map((c) => {
        const song = SONG_IDS.includes(c.song) || c.song === "none" ? c.song : SONG_IDS[0];
        return {
          id: typeof c.id === "string" ? c.id : uid("cat"),
          label: typeof c.label === "string" && c.label.trim() ? c.label : "catégorie",
          color: typeof c.color === "string" ? c.color : "#FF7A9A",
          song,
          // Migrate: keep an existing tempo, else seed from the song's BPM.
          tempo: c.tempo != null ? clampTempo(c.tempo) : defaultTempoForSong(song),
        };
      });
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

  const cleanBlocks = (blocks) =>
    Array.isArray(blocks)
      ? blocks
          .filter((b) => b && typeof b === "object")
          .map((b) => ({
            id: typeof b.id === "string" ? b.id : uid("blk"),
            name: typeof b.name === "string" ? b.name : "",
            repeat: clampRepeat(b.repeat),
            segments: cleanSegments(b.segments),
          }))
      : [];

  // Convert legacy flat `sequence` (+ old global loop flag) into one block, so
  // existing saved state keeps working — and an old "loop on" becomes a single
  // ∞ block, matching the previous behaviour.
  const segmentsToBlocks = (segs, legacyLoop) => {
    const clean = cleanSegments(segs);
    return clean.length ? [makeBlock(clean, legacyLoop ? 0 : 1)] : [];
  };

  if (Array.isArray(input.blocks)) {
    out.blocks = cleanBlocks(input.blocks);
  } else {
    const legacyLoop = !!(input.settings && input.settings.loop);
    out.blocks = segmentsToBlocks(input.sequence, legacyLoop);
  }

  // Active block (builder target): keep it only if it still exists, else point
  // at the first block (or null when there are none).
  out.activeBlockId =
    out.blocks.some((b) => b.id === input.activeBlockId)
      ? input.activeBlockId
      : out.blocks.length
      ? out.blocks[0].id
      : null;

  // Presets (with the same legacy migration for older preset shapes).
  if (Array.isArray(input.presets)) {
    out.presets = input.presets
      .filter((p) => p && typeof p === "object")
      .map((p) => ({
        id: typeof p.id === "string" ? p.id : uid("preset"),
        name: typeof p.name === "string" && p.name.trim() ? p.name : "Sans nom",
        blocks: Array.isArray(p.blocks)
          ? cleanBlocks(p.blocks)
          : segmentsToBlocks(p.segments, false),
      }));
  }

  // Settings
  if (input.settings && typeof input.settings === "object") {
    out.settings = {
      keepScreenAwake: !!input.settings.keepScreenAwake,
      beeps: !!input.settings.beeps,
      voiceURI:
        typeof input.settings.voiceURI === "string"
          ? input.settings.voiceURI
          : null,
      soundscape: ["none", "music", "cadence", "both"].includes(input.settings.soundscape)
        ? input.settings.soundscape
        : "none",
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

// A block's effective iteration count (Infinity for the ∞ sentinel).
function blockRepeatVal(b) {
  return b.repeat === 0 ? Infinity : b.repeat;
}
// Total play time of one block (all its repeats). Infinity if it loops forever.
function blockTotalSeconds(b) {
  return totalSequenceSeconds(b.segments) * blockRepeatVal(b);
}
// Total play time of a whole workout. Infinity if any block loops forever.
function blocksTotalSeconds(blocks) {
  let total = 0;
  for (const b of blocks) {
    const t = blockTotalSeconds(b);
    if (t === Infinity) return Infinity;
    total += t;
  }
  return total;
}
// How many segments are placed across all blocks (ignoring repeats).
function blocksSegmentCount(blocks) {
  return blocks.reduce((n, b) => n + b.segments.length, 0);
}
// Format a duration that might be infinite.
function formatTotal(sec) {
  return sec === Infinity ? "∞" : formatTime(sec);
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
  blocksList: $("blocks-list"),
  sequenceEmpty: $("sequence-empty"),
  totalDuration: $("total-duration"),
  btnAddBlock: $("btn-add-block"),
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
  selectSoundscape: $("select-soundscape"),
  btnPreviewSoundscape: $("btn-preview-soundscape"),
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

// The block new segments get added to: the active one, creating a first block
// on demand so tapping a category still "just works" on a fresh workout.
function targetBlock() {
  if (!state.blocks.length) {
    const b = makeBlock([], 1);
    state.blocks.push(b);
    state.activeBlockId = b.id;
    return b;
  }
  let b = state.blocks.find((x) => x.id === state.activeBlockId);
  if (!b) {
    b = state.blocks[state.blocks.length - 1];
    state.activeBlockId = b.id;
  }
  return b;
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
      const block = targetBlock();
      block.segments.push({ categoryId, durationSeconds: seconds });
      saveState();
      renderBlocks({ blockId: block.id, segIndex: block.segments.length - 1 });
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

// Render the whole workout as a stack of block cards.
// `highlight` (optional): { blockId, segIndex } to pop-in a just-added segment.
function renderBlocks(highlight) {
  const wrap = els.blocksList;
  wrap.innerHTML = "";

  // Keep the active-block pointer valid (first block by default, null if none).
  if (state.blocks.length && !state.blocks.some((b) => b.id === state.activeBlockId)) {
    state.activeBlockId = state.blocks[0].id;
  } else if (!state.blocks.length) {
    state.activeBlockId = null;
  }

  const noSegments = blocksSegmentCount(state.blocks) === 0;
  // The page-level empty note only shows when there are literally no blocks.
  els.sequenceEmpty.hidden = state.blocks.length > 0;
  els.btnStart.disabled = noSegments;
  els.btnSavePreset.disabled = noSegments;

  state.blocks.forEach((block, bi) => {
    wrap.appendChild(renderBlockCard(block, bi, highlight));
  });

  els.totalDuration.textContent = formatTotal(blocksTotalSeconds(state.blocks));
}

// Mark a block as the active edit target. Toggles the highlight in place rather
// than re-rendering, so a focused name field doesn't lose focus.
function setActiveBlock(id) {
  if (!id || state.activeBlockId === id) return;
  state.activeBlockId = id;
  saveState();
  els.blocksList.querySelectorAll(".blk-card").forEach((card) => {
    card.classList.toggle("is-active", card.dataset.blockId === id);
  });
}

function renderBlockCard(block, bi, highlight) {
  const card = document.createElement("div");
  card.className = "blk-card";
  card.dataset.blockId = block.id;
  if (block.id === state.activeBlockId) card.classList.add("is-active");
  // Tapping anywhere on the card (but not on a control) selects it as active.
  card.addEventListener("click", (e) => {
    if (e.target.closest("button, input, select")) return;
    setActiveBlock(block.id);
  });

  // ---- Header: name on its own line, then the controls row beneath it ----
  const head = document.createElement("div");
  head.className = "blk-head";

  // Name line: editable field + a pencil hint so it's obviously tappable.
  const nameRow = document.createElement("div");
  nameRow.className = "blk-name-row";
  const title = document.createElement("input");
  title.type = "text";
  title.className = "blk-name";
  title.value = block.name || "";
  title.placeholder = `Bloc ${bi + 1}`;
  title.maxLength = 30;
  title.setAttribute("aria-label", `Nom du ${blockDisplayName(block, bi)}`);
  title.addEventListener("focus", () => setActiveBlock(block.id));
  title.addEventListener("input", () => {
    block.name = title.value;
    saveState(); // no re-render: keep the field focused while typing
  });
  const editHint = document.createElement("span");
  editHint.className = "blk-edit-hint";
  editHint.textContent = "✎";
  editHint.setAttribute("aria-hidden", "true");
  nameRow.appendChild(title);
  nameRow.appendChild(editHint);

  // Controls line: repeat stepper · subtotal · move/delete.
  const controls = document.createElement("div");
  controls.className = "blk-controls";

  // Block subtotal — presentational only, so it's a stopwatch icon + plain
  // text on the card background (no button chrome, unlike the segment durations).
  const total = document.createElement("span");
  total.className = "blk-total";
  total.setAttribute("aria-label", `Durée du bloc : ${formatTotal(blockTotalSeconds(block))}`);
  total.innerHTML =
    `<svg class="ico" viewBox="0 -960 960 960" width="16" height="16" aria-hidden="true">${STOPWATCH_PATH}</svg>` +
    `<span class="blk-total-text"></span>`;
  total.querySelector(".blk-total-text").textContent = formatTotal(blockTotalSeconds(block));

  const ctrls = document.createElement("div");
  ctrls.className = "blk-ctrls";
  ctrls.appendChild(miniBtn("▲", "Monter le bloc", bi === 0, () => moveBlock(bi, -1)));
  ctrls.appendChild(
    miniBtn("▼", "Descendre le bloc", bi === state.blocks.length - 1, () => moveBlock(bi, 1))
  );
  ctrls.appendChild(miniBtn("✕", "Supprimer le bloc", false, () => deleteBlock(bi), true));

  controls.appendChild(buildRepeatControl(block));
  controls.appendChild(total);
  controls.appendChild(ctrls);

  head.appendChild(nameRow);
  head.appendChild(controls);
  card.appendChild(head);

  // ---- Segment list ----
  if (block.segments.length === 0) {
    const note = document.createElement("p");
    note.className = "empty-note blk-empty";
    note.textContent = "Bloc vide. Touche une catégorie pour y ajouter un segment.";
    card.appendChild(note);
  } else {
    const list = document.createElement("ol");
    list.className = "seq-list";
    block.segments.forEach((seg, si) => {
      list.appendChild(renderSegItem(block, bi, seg, si, highlight));
    });
    card.appendChild(list);
  }

  return card;
}

// The compact ×N / ∞ repeat stepper that sits in each block header.
function buildRepeatControl(block) {
  const wrap = document.createElement("div");
  wrap.className = "blk-rep";

  const isInf = block.repeat === 0;

  const minus = miniBtn("−", "Moins de répétitions", false, () =>
    setRepeat(block, isInf ? 1 : Math.max(1, block.repeat - 1))
  );
  const plus = miniBtn("+", "Plus de répétitions", false, () =>
    setRepeat(block, isInf ? 0 : block.repeat + 1)
  );

  const val = document.createElement("button");
  val.type = "button";
  val.className = "blk-rep-val";
  val.textContent = isInf ? "∞" : block.repeat + "×";
  val.title = isInf ? "Boucle infinie — toucher pour repasser à 1×" : "Toucher pour une boucle infinie";
  val.setAttribute(
    "aria-label",
    isInf
      ? "Répétitions : infini. Toucher pour repasser à une fois."
      : `Répétitions : ${block.repeat}. Toucher pour une boucle infinie.`
  );
  val.addEventListener("click", () => setRepeat(block, isInf ? 1 : 0));

  wrap.appendChild(minus);
  wrap.appendChild(val);
  wrap.appendChild(plus);
  return wrap;
}

function setRepeat(block, n) {
  block.repeat = clampRepeat(n);
  saveState();
  renderBlocks();
}

function renderSegItem(block, bi, seg, si, highlight) {
  const cat = getCategory(seg.categoryId);
  const li = document.createElement("li");
  li.className = "seq-item";
  if (highlight && highlight.blockId === block.id && highlight.segIndex === si) {
    li.classList.add("just-added");
  }

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
        renderBlocks();
      },
    });
  });

  const btns = document.createElement("div");
  btns.className = "seq-btns";
  btns.appendChild(miniBtn("▲", "Monter", si === 0, () => moveSegment(bi, si, -1)));
  btns.appendChild(
    miniBtn("▼", "Descendre", si === block.segments.length - 1, () => moveSegment(bi, si, 1))
  );
  btns.appendChild(miniBtn("✕", "Supprimer", false, () => deleteSegment(bi, si), true));

  // Top line: colour marker + label. Bottom line: duration + move/delete.
  const top = document.createElement("div");
  top.className = "seq-top";
  top.appendChild(color);
  top.appendChild(main);

  const bottom = document.createElement("div");
  bottom.className = "seq-bottom";
  bottom.appendChild(dur);
  bottom.appendChild(btns);

  li.appendChild(top);
  li.appendChild(bottom);
  return li;
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

/* ---- Block & segment mutations ---- */

function addBlock() {
  const b = makeBlock([], 1);
  state.blocks.push(b);
  state.activeBlockId = b.id; // a new block becomes the edit target
  saveState();
  renderBlocks();
}

function moveBlock(bi, delta) {
  const j = bi + delta;
  if (j < 0 || j >= state.blocks.length) return;
  const arr = state.blocks;
  [arr[bi], arr[j]] = [arr[j], arr[bi]];
  saveState();
  renderBlocks();
}

function deleteBlock(bi) {
  const block = state.blocks[bi];
  if (!block) return;
  // Only nag about confirmation when there's content to lose.
  if (block.segments.length && !window.confirm(`Supprimer « ${blockDisplayName(block, bi)} » ?`)) return;
  const wasActive = block.id === state.activeBlockId;
  state.blocks.splice(bi, 1);
  // If we removed the active block, fall back to its neighbour.
  if (wasActive) {
    const next = state.blocks[bi] || state.blocks[bi - 1] || null;
    state.activeBlockId = next ? next.id : null;
  }
  saveState();
  renderBlocks();
}

function moveSegment(bi, si, delta) {
  const block = state.blocks[bi];
  if (!block) return;
  const j = si + delta;
  if (j < 0 || j >= block.segments.length) return;
  const arr = block.segments;
  [arr[si], arr[j]] = [arr[j], arr[si]];
  saveState();
  renderBlocks();
}

function deleteSegment(bi, si) {
  const block = state.blocks[bi];
  if (!block) return;
  block.segments.splice(si, 1);
  saveState();
  renderBlocks();
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
      blocksSegmentCount(preset.blocks) + " · " + formatTotal(blocksTotalSeconds(preset.blocks));

    const loadBtn = miniBtn("↺", "Charger", false, () => loadPreset(preset.id));
    const delBtn = miniBtn("✕", "Supprimer", false, () => deletePreset(preset.id), true);

    li.appendChild(name);
    li.appendChild(meta);
    li.appendChild(loadBtn);
    li.appendChild(delBtn);
    list.appendChild(li);
  });
}

// Deep-copy blocks so later builder edits never mutate a saved/loaded copy.
function cloneBlocks(blocks) {
  return blocks.map((b) => ({
    id: uid("blk"),
    name: b.name || "",
    repeat: b.repeat,
    segments: b.segments.map((s) => ({ ...s })),
  }));
}

function saveCurrentAsPreset() {
  if (blocksSegmentCount(state.blocks) === 0) return;
  const name = window.prompt("Nom de la séquence", "Ma séquence");
  if (name === null) return;
  const clean = name.trim() || "Sans nom";
  state.presets.push({
    id: uid("preset"),
    name: clean,
    blocks: cloneBlocks(state.blocks),
  });
  saveState();
  renderPresets();
  showToast("Séquence enregistrée ✿");
}

function loadPreset(id) {
  const preset = state.presets.find((p) => p.id === id);
  if (!preset) return;
  state.blocks = cloneBlocks(preset.blocks);
  state.activeBlockId = state.blocks.length ? state.blocks[0].id : null;
  saveState();
  renderBlocks();
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
    version: 2,
    categories: state.categories,
    presets: state.presets,
    blocks: state.blocks,
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
      // Accept both the new `blocks` shape and the legacy flat `sequence`;
      // keep the current workout if the file carries neither.
      const merged = validateState({
        categories: state.categories,
        presets: (state.presets || []).concat(data.presets || []),
        blocks: Array.isArray(data.blocks)
          ? data.blocks
          : Array.isArray(data.sequence)
          ? undefined
          : state.blocks,
        sequence: !Array.isArray(data.blocks) ? data.sequence : undefined,
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
      renderBlocks();
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
      renderBlocks();
    });

    const del = miniBtn("✕", "Supprimer la catégorie", false, () => {
      if (!window.confirm(`Supprimer la catégorie « ${cat.label} » ?`)) return;
      state.categories = state.categories.filter((c) => c.id !== cat.id);
      // Drop any block/preset segments that used it (across all blocks).
      const dropFromBlocks = (blocks) =>
        blocks.forEach((b) => {
          b.segments = b.segments.filter((s) => s.categoryId !== cat.id);
        });
      dropFromBlocks(state.blocks);
      state.presets.forEach((p) => dropFromBlocks(p.blocks));
      saveState();
      renderAll();
      renderCategoryEditor();
    }, true);

    // Song picker — which generative track plays during this category's segments.
    const song = document.createElement("select");
    song.className = "cat-song";
    song.setAttribute("aria-label", "Musique de " + cat.label);
    const noneOpt = document.createElement("option");
    noneOpt.value = "none";
    noneOpt.textContent = "♪ Aucune";
    song.appendChild(noneOpt);
    SONGS.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = "♪ " + s.name;
      song.appendChild(opt);
    });
    song.value = cat.song || SONG_IDS[0];
    song.addEventListener("change", () => {
      cat.song = song.value;
      saveState();
      const cur = currentSegment();
      if (run.active) {
        // If a segment of this category is playing right now, switch live.
        if (
          cur && cur.categoryId === cat.id &&
          scape.running && (scape.mode === "music" || scape.mode === "both")
        ) {
          scape.songId = activeSongId();
          scape.step = 0;
        }
      } else {
        // Not running — play a short sample so the user hears their pick.
        previewCategory(cat);
      }
    });

    // Tempo slider — governs BOTH this category's song and its metronome, so
    // they're always in sync. The label reads out the current BPM.
    const tempoWrap = document.createElement("div");
    tempoWrap.className = "cat-tempo";
    const tempoHead = document.createElement("div");
    tempoHead.className = "cat-tempo-head";
    const tempoName = document.createElement("span");
    tempoName.textContent = "Tempo";
    const tempoVal = document.createElement("span");
    tempoVal.className = "cat-tempo-val";
    tempoVal.textContent = categoryTempo(cat) + " BPM";
    tempoHead.appendChild(tempoName);
    tempoHead.appendChild(tempoVal);

    const tempo = document.createElement("input");
    tempo.type = "range";
    tempo.className = "range";
    tempo.min = String(TEMPO_MIN);
    tempo.max = String(TEMPO_MAX);
    tempo.step = "1";
    tempo.value = String(categoryTempo(cat));
    tempo.setAttribute("aria-label", "Tempo de " + cat.label + " (BPM)");
    tempo.addEventListener("input", () => {
      const v = clampTempo(tempo.value);
      cat.tempo = v;
      tempoVal.textContent = v + " BPM";
      saveState();
      // If this category is sounding right now, retune live (music + metronome).
      const cur = currentSegment();
      if (run.active && scape.running && cur && cur.categoryId === cat.id) {
        scape.tempo = v;
      }
    });
    // Audition on release (not on every drag tick) so the loop doesn't thrash.
    tempo.addEventListener("change", () => { if (!run.active) previewCategory(cat); });

    tempoWrap.appendChild(tempoHead);
    tempoWrap.appendChild(tempo);

    row.appendChild(color);
    row.appendChild(label);
    row.appendChild(del);
    row.appendChild(song);
    row.appendChild(tempoWrap);
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
  state.categories.push({
    id: uid("cat"),
    label: clean,
    color,
    song: SONG_IDS[0],
    tempo: defaultTempoForSong(SONG_IDS[0]),
  });
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
// `onDone` (optional) fires once the utterance finishes naturally — used to
// chain a follow-up cue after a gap. It does NOT fire when the utterance is
// superseded by a later speak() (interrupted/canceled).
function speak(text, useVoice, onDone) {
  if (!("speechSynthesis" in window)) { if (onDone) onDone(); return; }
  if (useVoice === undefined) useVoice = true;
  try {
    const synth = window.speechSynthesis;
    synth.cancel(); // never queue cues up

    const u = new SpeechSynthesisUtterance(text);
    u.lang = "fr-FR";
    u.rate = 1;

    const v = useVoice ? selectedVoice() : null;
    if (v) u.voice = v;

    let doneFired = false;
    const fireDone = () => {
      if (!doneFired && typeof onDone === "function") { doneFired = true; onDone(); }
    };

    // Keep a reference (Chrome GC fix); drop it when the utterance settles.
    _utterances.push(u);
    const release = () => {
      const i = _utterances.indexOf(u);
      if (i !== -1) _utterances.splice(i, 1);
      duckSoundscape(false); // restore music volume after the cue
    };
    let started = false;
    u.onstart = () => { started = true; _speechEverStarted = true; duckSoundscape(true); };
    u.onend = () => { release(); fireDone(); };
    u.onerror = (e) => {
      release();
      const err = e && e.error;
      // "interrupted"/"canceled" fire whenever we cancel() for the next
      // segment — those are normal (and must NOT trigger onDone). A real
      // failure with a voice set: retry once with no voice (covers the
      // iOS-Safari ".voice fails silently" case), carrying onDone forward.
      if (err === "interrupted" || err === "canceled") return;
      if (useVoice && err) speak(text, false, onDone);
      else fireDone(); // failed with no retry path — still advance the chain
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
    // neither re-arms this watchdog nor loops; onDone rides along with it.
    if (useVoice && v) {
      setTimeout(() => {
        if (!started) speak(text, false, onDone);
      }, 700);
    }
  } catch (e) { if (onDone) onDone(); }
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

// Pending "speak the segment after the block-name lead" timer, so a quick
// skip cancels a follow-up cue that no longer applies.
let _announceTimer = null;
const ANNOUNCE_GAP_MS = 1000; // pause between the block name and the segment

function clearPendingAnnounce() {
  if (_announceTimer) { clearTimeout(_announceTimer); _announceTimer = null; }
}

// Announce a segment: "Marche, deux minutes". On the first segment of a block
// we lead with the block's name (or "Bloc final" for an unnamed last block),
// THEN pause ~1s before naming the segment. The very last segment of a finite
// workout adds "Dernier segment" to that lead.
function announceSegment(seg) {
  clearPendingAnnounce();

  const cat = getCategory(seg.categoryId);
  const label = cat ? cat.label : "segment";
  const phrase = `${label}, ${spokenDuration(seg.durationSeconds)}`;

  const block = run.blocks[run.blockIndex];
  const enteringBlock = run.iter === 1 && run.segIndex === 0;
  const named = block ? (block.name || "").trim() : "";
  const isFinalSegment =
    workoutIsFinite() && nextPos(run.blockIndex, run.iter, run.segIndex) === null;

  const lead = [];
  if (enteringBlock && named) lead.push(named);
  else if (enteringBlock && onLastBlock() && run.blocks.length > 1) lead.push("Bloc final");
  if (isFinalSegment) lead.push("Dernier segment");

  if (!lead.length) {
    speak(phrase);
    return;
  }

  // Say the lead, then wait a beat once it finishes before the segment name.
  speak(lead.join(". "), true, () => {
    _announceTimer = setTimeout(() => {
      _announceTimer = null;
      if (run.active && !run.paused) speak(phrase);
    }, ANNOUNCE_GAP_MS);
  });
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

// Briefly duck the music under a chime, then restore.
function duckForChime(ms) {
  duckSoundscape(true);
  setTimeout(() => duckSoundscape(false), ms);
}

// Two-note rising carillon at a segment transition (gated by the Sons toggle).
function chimeTransition() {
  if (!state.settings.beeps) return;
  duckForChime(700);
  tone(587.33, 0, 0.16, 0.18, "sine");   // D5
  tone(880.0, 0.1, 0.24, 0.18, "sine");  // A5
}

// Cheerful ascending arpeggio for "séance terminée" (gated by the Sons toggle).
function chimeFinish() {
  if (!state.settings.beeps) return;
  duckForChime(1100);
  const notes = [
    [523.25, 0.0, 0.22],   // C5
    [659.25, 0.13, 0.22],  // E5
    [783.99, 0.26, 0.22],  // G5
    [1046.5, 0.4, 0.5],    // C6 (held)
  ];
  notes.forEach(([f, o, d]) => tone(f, o, d, 0.2, "triangle"));
}

/* ----------------------------------------------------------------------- */
/* 8b. Procedural soundscape — generative upbeat music + cadence metronome  */
/*     Foreground-only. Everything is synthesised on the Web Audio clock;   */
/*     no audio files are bundled.                                          */
/* ----------------------------------------------------------------------- */

const SCHED_INTERVAL_MS = 25;   // how often the lookahead scheduler runs
const SCHED_AHEAD = 0.18;       // schedule notes this far ahead (s)

// The category whose song/tempo should sound right now: the running segment's
// category, or (when idle, e.g. a Settings preview) the first category.
function activeCategory() {
  const seg = currentSegment();
  if (seg) return getCategory(seg.categoryId);
  return state.categories[0] || null;
}
// The tempo (BPM) for a category — governs its song AND its metronome.
function categoryTempo(cat) {
  if (!cat) return 160;
  return clampTempo(cat.tempo != null ? cat.tempo : defaultTempoForSong(cat.song));
}
function activeTempo() {
  return categoryTempo(activeCategory());
}
// Which song should play right now, taken from the active category.
function activeSongId() {
  const cat = activeCategory();
  const id = cat && cat.song ? cat.song : SONG_IDS[0];
  if (id === "none") return "none";
  return getSong(id) ? id : SONG_IDS[0];
}

const scape = {
  running: false,
  mode: "none",
  master: null,        // duckable master gain for the whole soundscape
  timer: null,
  step: 0,             // 16th-note counter (music)
  songId: null,        // id of the song currently playing (from the active segment)
  tempo: 160,          // current BPM (from the active category) — drives both voices
  nextNoteTime: 0,     // next music 16th to schedule (audioCtx time)
  beat: 0,             // cadence beat counter
  nextClickTime: 0,    // next metronome click (audioCtx time)
  noiseBuf: null,      // cached white-noise buffer for the shaker
  previewTimer: null,
};

function scapeMaster() {
  if (!audioCtx) return null;
  if (!scape.master) {
    scape.master = audioCtx.createGain();
    scape.master.gain.value = 1.0;
    scape.master.connect(audioCtx.destination);
  }
  return scape.master;
}

function noiseBuffer() {
  if (scape.noiseBuf) return scape.noiseBuf;
  const len = Math.floor(audioCtx.sampleRate * 0.1);
  const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  scape.noiseBuf = buf;
  return buf;
}

// ---- Individual voices (each a short, self-stopping one-shot) ----

function playBass(time, freq) {
  const o = audioCtx.createOscillator();
  const f = audioCtx.createBiquadFilter();
  const g = audioCtx.createGain();
  o.type = "sawtooth";
  o.frequency.setValueAtTime(freq, time);
  f.type = "lowpass"; f.frequency.value = 380;
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(0.17, time + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.19);
  o.connect(f); f.connect(g); g.connect(scape.master);
  o.start(time); o.stop(time + 0.21);
}

function playPluck(time, freq) {
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = "triangle";
  o.frequency.setValueAtTime(freq, time);
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(0.12, time + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.22);
  o.connect(g); g.connect(scape.master);
  o.start(time); o.stop(time + 0.24);
}

// Rhythmic chord stab — short, punchy synth-pop hit. Voiced an octave up to
// clear the bass; a quick filter "snap" gives it that plucky stab character.
function playStab(time, triad, wave) {
  const f = audioCtx.createBiquadFilter();
  const g = audioCtx.createGain();
  f.type = "lowpass";
  f.Q.value = 5;
  f.frequency.setValueAtTime(3400, time);                  // snap open...
  f.frequency.exponentialRampToValueAtTime(800, time + 0.16); // ...then close
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(0.085, time + 0.008); // fast attack
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.2);  // short decay
  f.connect(g); g.connect(scape.master);
  triad.forEach((fr, i) => {
    const o = audioCtx.createOscillator();
    o.type = wave || "sawtooth";
    o.frequency.setValueAtTime(fr * 2, time); // octave up, above the bass/arp mud
    o.detune.value = (i - 1) * 8;             // slight width
    o.connect(f);
    o.start(time); o.stop(time + 0.22);
  });
}

function playShaker(time, accent) {
  const dur = 0.05;
  const src = audioCtx.createBufferSource();
  const f = audioCtx.createBiquadFilter();
  const g = audioCtx.createGain();
  src.buffer = noiseBuffer();
  f.type = "highpass"; f.frequency.value = 7000;
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(accent ? 0.11 : 0.055, time + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  src.connect(f); f.connect(g); g.connect(scape.master);
  src.start(time); src.stop(time + dur + 0.02);
}

function playClap(time) {
  const dur = 0.09;
  const src = audioCtx.createBufferSource();
  const f = audioCtx.createBiquadFilter();
  const g = audioCtx.createGain();
  src.buffer = noiseBuffer();
  f.type = "bandpass"; f.frequency.value = 1500; f.Q.value = 0.7;
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(0.14, time + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  src.connect(f); f.connect(g); g.connect(scape.master);
  src.start(time); src.stop(time + dur + 0.02);
}

function playClick(time, accent) {
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = "square";
  o.frequency.setValueAtTime(accent ? 1600 : 1100, time);
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(accent ? 0.2 : 0.12, time + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
  o.connect(g); g.connect(scape.master);
  o.start(time); o.stop(time + 0.06);
}

// ---- Sequencers ----

function musicScheduler() {
  const song = getSong(scape.songId);
  // "Aucune" (or unknown) → no music for this segment; advance the clock silently.
  if (!song) {
    const sx = 60 / (scape.tempo || 160) / 4;
    while (scape.nextNoteTime < audioCtx.currentTime + SCHED_AHEAD) {
      scape.nextNoteTime += sx; scape.step++;
    }
    return;
  }
  const sixteenth = 60 / scape.tempo / 4;
  while (scape.nextNoteTime < audioCtx.currentTime + SCHED_AHEAD) {
    const t = scape.nextNoteTime;
    const bar = Math.floor(scape.step / 16) % song.prog.length;
    const inBar = scape.step % 16;
    const chord = song.prog[bar];

    if (song.stab.includes(inBar)) playStab(t, chord.triad, song.stabWave); // chord stabs
    if (inBar % song.bassMod === 0) playBass(t, chord.bass);                // driving bass
    if (song.arpMod && inBar % song.arpMod === 0) {                         // melodic arp
      const arp = [
        chord.triad[0], chord.triad[1], chord.triad[2], chord.triad[1] * 2,
        chord.triad[0] * 2, chord.triad[2], chord.triad[1], chord.triad[0] * 2,
      ];
      playPluck(t, arp[Math.floor(inBar / song.arpMod) % arp.length]);
    }
    if (song.shaker && inBar % 4 === 2) playShaker(t, inBar === 10);        // offbeat groove
    if (song.clap && (inBar === 4 || inBar === 12)) playClap(t);            // backbeat clap

    scape.nextNoteTime += sixteenth;
    scape.step++;
  }
}

function cadenceScheduler() {
  const period = 60 / (scape.tempo || 160);
  while (scape.nextClickTime < audioCtx.currentTime + SCHED_AHEAD) {
    playClick(scape.nextClickTime, scape.beat % 4 === 0);
    scape.nextClickTime += period;
    scape.beat++;
  }
}

function scapeTick() {
  if (!audioCtx) return;
  if (scape.mode === "music" || scape.mode === "both") musicScheduler();
  if (scape.mode === "cadence" || scape.mode === "both") cadenceScheduler();
}

// ---- Lifecycle ----

// opts (optional): { mode, songId, tempo } to force a specific mode/song/tempo
// — used by previews. Without opts it follows the saved mode + active category.
function startSoundscape(opts) {
  if (!audioCtx) return;
  const mode = (opts && opts.mode) || state.settings.soundscape;
  if (!mode || mode === "none" || scape.running) return;
  scapeMaster();
  const now = audioCtx.currentTime;
  scape.master.gain.cancelScheduledValues(now);
  scape.master.gain.setValueAtTime(1.0, now); // un-duck on (re)start
  scape.running = true;
  scape.mode = mode;
  scape.step = 0;
  scape.beat = 0;
  scape.songId = (opts && opts.songId) || activeSongId();
  scape.tempo = (opts && opts.tempo != null) ? clampTempo(opts.tempo) : activeTempo();
  const t0 = now + 0.1;
  scape.nextNoteTime = t0;
  scape.nextClickTime = t0;
  scape.timer = setInterval(scapeTick, SCHED_INTERVAL_MS);
}

function stopSoundscape() {
  scape.running = false;
  scape.mode = "none";
  if (scape.timer) { clearInterval(scape.timer); scape.timer = null; }
  if (scape.previewTimer) { clearTimeout(scape.previewTimer); scape.previewTimer = null; }
  // Voices are short scheduled one-shots, so they tail off on their own.
}

// Smoothly dip the music while a voice cue / chime plays, then restore.
function duckSoundscape(active) {
  if (!scape.master || !audioCtx || !scape.running) return;
  const now = audioCtx.currentTime;
  const target = active ? 0.3 : 1.0;
  scape.master.gain.cancelScheduledValues(now);
  scape.master.gain.setValueAtTime(scape.master.gain.value, now);
  scape.master.gain.linearRampToValueAtTime(target, now + (active ? 0.08 : 0.6));
}

// Settings preview — play the current selection for a few seconds (not during a run).
function previewSoundscape() {
  if (run.active) return;
  unlockAudio();
  stopSoundscape();
  startSoundscape();
  if (!scape.running) { showToast("Choisis une ambiance"); return; }
  scape.previewTimer = setTimeout(stopSoundscape, 7000);
}

// Audition a category's song + tempo for a couple of bars — used when editing
// a category. Skipped during a run (the live switch handles that instead).
// Picks a sensible mode so there's always audible feedback: the saved ambiance
// if set, otherwise music (or the metronome when the category has no song).
function previewCategory(cat) {
  if (run.active || !cat) return;
  const hasSong = cat.song && cat.song !== "none" && getSong(cat.song);
  let mode = state.settings.soundscape;
  if (mode === "none") mode = hasSong ? "music" : "cadence";
  if ((mode === "music" || mode === "both") && !hasSong) mode = "cadence";
  unlockAudio();
  stopSoundscape();
  startSoundscape({ mode, songId: cat.song, tempo: cat.tempo });
  if (!scape.running) return;
  scape.previewTimer = setTimeout(stopSoundscape, 3500);
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
      album: runProgressText(),
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
  blocks: [],          // snapshot of the non-empty blocks at start (deep-copied)
  blockIndex: 0,       // current block
  iter: 1,             // current iteration within the block (1-based)
  segIndex: 0,         // current segment within the block
  segmentEndAt: 0,     // Date.now() ms when the current segment ends
  remainingWhenPaused: 0, // ms remaining, captured on pause
  rafId: null,
  lastBeepSecond: null, // guards 3-2-1 beeps from firing twice
  lastPulseSecond: null, // guards the ring/time "tick" bloom from firing twice
};

function currentSegment() {
  const block = run.blocks[run.blockIndex];
  return block ? block.segments[run.segIndex] || null : null;
}

// ---- Cursor maths over blocks × iterations × segments ----
// A position is { bi, it, si }. These walk forward/back across the whole
// workout, looping a block for its repeat count before moving to the next.

function nextPos(bi, it, si) {
  const block = run.blocks[bi];
  if (!block) return null;
  // More segments left in this iteration?
  if (si + 1 < block.segments.length) return { bi, it, si: si + 1 };
  // Another iteration of this block? (Infinity for the ∞ sentinel.)
  if (it + 1 <= blockRepeatVal(block)) return { bi, it: it + 1, si: 0 };
  // Otherwise advance to the next block.
  if (bi + 1 < run.blocks.length) return { bi: bi + 1, it: 1, si: 0 };
  return null;
}

function prevPos(bi, it, si) {
  if (si > 0) return { bi, it, si: si - 1 };
  if (it > 1) return { bi, it: it - 1, si: run.blocks[bi].segments.length - 1 };
  if (bi > 0) {
    const prev = run.blocks[bi - 1];
    // Land on the last iteration of the previous block (1 if it loops forever).
    const lastIt = prev.repeat === 0 ? 1 : prev.repeat;
    return { bi: bi - 1, it: lastIt, si: prev.segments.length - 1 };
  }
  return null;
}

// Is the current block the last one (so it's the "final block")?
function onLastBlock() {
  return run.blockIndex === run.blocks.length - 1;
}

// Whole workout has a finite number of segments (no ∞ block anywhere)?
function workoutIsFinite() {
  return run.blocks.every((b) => b.repeat !== 0);
}

// Text for the top progress pill: blocks/iterations when there's structure,
// else the plain "n / N" segment counter for a simple single-block workout.
function runProgressText() {
  const block = run.blocks[run.blockIndex];
  if (!block) return "";
  const B = run.blocks.length;
  const r = blockRepeatVal(block);
  // Prefer a custom name; otherwise "Bloc i/B" when there's more than one block.
  const named = (block.name || "").trim();
  const label = named || (B > 1 ? `Bloc ${run.blockIndex + 1}/${B}` : "");
  const parts = [];
  if (label) parts.push(label);
  if (r > 1) parts.push(r === Infinity ? `tour ${run.iter}` : `tour ${run.iter}/${r}`);
  if (parts.length) return parts.join(" · ");
  return `${run.segIndex + 1} / ${block.segments.length}`;
}

function startRun() {
  // Snapshot the workout, dropping empty blocks. Bail if there's nothing to do.
  const blocks = state.blocks
    .map((b) => ({
      id: b.id,
      name: b.name || "",
      repeat: b.repeat,
      segments: b.segments.map((s) => ({ ...s })),
    }))
    .filter((b) => b.segments.length);
  if (!blocks.length) return;

  // Unlock audio within this user gesture (critical for iOS).
  unlockAudio();
  startSilentAudio();
  setupMediaSession();
  acquireWakeLock();

  run.active = true;
  run.paused = false;
  run.blocks = blocks;
  run.blockIndex = 0;
  run.iter = 1;
  run.segIndex = 0;

  startSoundscape(); // now that run.blocks is set, picks the right starting song

  showScreen("run");
  beginSegment({ bi: 0, it: 1, si: 0 }, /*announce*/ true);
  maybeWarnNoSpeech(); // hint once if this browser's TTS is wedged
  loop();
}

// Set up the segment at `pos` ({ bi, it, si }). Computes the absolute end time.
function beginSegment(pos, announce) {
  run.blockIndex = pos.bi;
  run.iter = pos.it;
  run.segIndex = pos.si;
  const seg = currentSegment();
  if (!seg) return;

  run.segmentEndAt = Date.now() + seg.durationSeconds * 1000;
  run.lastBeepSecond = null;
  run.lastPulseSecond = null;

  // Visuals
  const cat = getCategory(seg.categoryId);
  els.runCategory.textContent = cat ? cat.label : "segment";
  els.runProgress.textContent = runProgressText();

  // Next-segment hint
  const next = nextSegmentLabel();
  els.runNext.textContent = next ? `Suivant : ${next}` : "Dernier segment";

  updateMediaSessionMetadata();

  // Retune the soundscape to this segment's category: its song (music modes)
  // and its tempo (both music and metronome), restarting music at bar 1 for a
  // clean "new section" feel.
  if (scape.running) {
    scape.tempo = activeTempo();
    if (scape.mode === "music" || scape.mode === "both") {
      scape.songId = activeSongId();
      scape.step = 0;
    }
  }

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
  const np = nextPos(run.blockIndex, run.iter, run.segIndex);
  if (!np) return null;
  const seg = run.blocks[np.bi].segments[np.si];
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
  const np = nextPos(run.blockIndex, run.iter, run.segIndex);
  if (np) beginSegment(np, true);
  else finishRun();
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
  clearPendingAnnounce();
  if (run.rafId) cancelAnimationFrame(run.rafId);
  run.rafId = null;
  stopSilentAudio();
  stopSoundscape();
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
  stopSoundscape();
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
  startSoundscape();
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
  const np = nextPos(run.blockIndex, run.iter, run.segIndex);
  if (np) {
    if (run.paused) resumeRun();
    beginSegment(np, true);
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
  const here = { bi: run.blockIndex, it: run.iter, si: run.segIndex };
  if (elapsedMs > 2000) {
    beginSegment(here, true);
  } else {
    beginSegment(prevPos(run.blockIndex, run.iter, run.segIndex) || here, true);
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
  renderBlocks();
  renderPresets();
}

/* ---- Wire up events ---- */

function bindEvents() {
  // Add a new block
  els.btnAddBlock.addEventListener("click", addBlock);

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
    els.selectSoundscape.value = state.settings.soundscape;
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

  // Soundscape (generative music / cadence)
  els.selectSoundscape.addEventListener("change", () => {
    state.settings.soundscape = els.selectSoundscape.value;
    saveState();
    // Apply live if a run is in progress.
    if (run.active && !run.paused) {
      stopSoundscape();
      startSoundscape();
    }
  });
  els.btnPreviewSoundscape.addEventListener("click", previewSoundscape);

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
