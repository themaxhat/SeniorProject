/* ---------- 1. Local storage (IndexedDB) ----------
   Data stays in this browser on this computer. Nothing is sent anywhere.
   IndexedDB can store audio files (Blobs) directly, unlike localStorage. */

const input = document.getElementById("message");
const statusEl = document.getElementById("status");

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("chat-db", 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("entries", { keyPath: "id", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbRun(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("entries", mode);
    const request = fn(tx.objectStore("entries"));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
  });
}

const addEntry = (entry) => dbRun("readwrite", (store) => store.add(entry));
const getEntries = () => dbRun("readonly", (store) => store.getAll());
const clearAllData = () => dbRun("readwrite", (store) => store.clear());
const deleteEntries = (ids) => dbRun("readwrite", (store) => { ids.forEach((id) => store.delete(id)); });

// Ask the browser not to evict this data when disk space runs low
if (navigator.storage?.persist) navigator.storage.persist();

function setStatus(message) {
  statusEl.textContent = message;
}


/* ---------- 2. Recording audio (MediaRecorder) ----------
   Records straight from the microphone in the browser.
   No speech-to-text, so no audio leaves your computer. */

const micBtn = document.getElementById("mic");
let pendingRecordings = [];   // recordings waiting to be saved with the next Enter
let recorder = null;

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    recorder = new MediaRecorder(stream);

    recorder.ondataavailable = (e) => chunks.push(e.data);

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType });
      pendingRecordings.push({ blob, type: blob.type, recordedAt: new Date().toISOString() });
      stream.getTracks().forEach((t) => t.stop());   // release the mic
      micBtn.classList.remove("listening");
      recorder = null;
      showPending();
    };

    recorder.start();
    micBtn.classList.add("listening");
    setStatus("Recording… click the mic to stop.");
  } catch (err) {
    console.warn("Mic error:", err);
    setStatus("Couldn't access the microphone. Check your browser's permission.");
  }
}

// Resolves once the recorder has stopped and its audio is in pendingRecordings
function stopRecording() {
  if (!recorder) return Promise.resolve();
  return new Promise((resolve) => {
    recorder.addEventListener("stop", () => setTimeout(resolve, 0), { once: true });
    recorder.stop();
  });
}

function showPending() {
  const n = pendingRecordings.length;
  setStatus(n ? `${n} recording${n > 1 ? "s" : ""} ready. Press Enter to save.` : "");
}

micBtn.addEventListener("click", () => {
  if (recorder) stopRecording();
  else startRecording();
});


/* ---------- 3. Enter saves text + all pending recordings ---------- */

input.addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;

  const text = input.value.trim();
  await stopRecording();   // finish a recording that's still running

  if (!text && pendingRecordings.length === 0) return;

  await addEntry({
    text,
    recordings: pendingRecordings,
    time: new Date().toISOString(),
  });

  input.value = "";
  pendingRecordings = [];
  if (drawerOpen) renderHistory();
  setStatus("Saved.");
  setTimeout(() => setStatus(""), 1800);
});


/* ---------- 4. Reading saved data back (try these in the console) ----------
   await getEntries()          -> all saved entries
   await playRecording(1, 0)   -> play entry id 1, first recording
   await clearAllData()        -> delete everything                          */

async function playRecording(entryId, index = 0) {
  const entries = await getEntries();
  const entry = entries.find((x) => x.id === entryId);
  const rec = entry?.recordings[index];
  if (!rec) return console.warn("No recording found.");
  new Audio(URL.createObjectURL(rec.blob)).play();
}


/* ---------- 5. TEMPORARY speaker test ----------
   Remove this section and the #speaker button in index.html when done. */

const speakerBtn = document.getElementById("speaker");
let audioCtx;

function playBeep(frequency = 660, duration = 0.25) {
  audioCtx = audioCtx || new AudioContext();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + duration);
}

speakerBtn.addEventListener("click", () => {
  playBeep(660, 0.2);
  setTimeout(() => playBeep(880, 0.25), 220);
});



/* ---------- 6. History drawer ---------- */

const drawer = document.getElementById("history");
const backdrop = document.getElementById("backdrop");
const historyBtn = document.getElementById("history-btn");
const closeBtn = document.getElementById("history-close");
const listEl = document.getElementById("history-list");
const editBtn = document.getElementById("edit-btn");
const clearBtn = document.getElementById("clear-btn");

let drawerOpen = false;
let editing = false;
let selected = new Set();
let entryCount = 0;
let renderToken = 0;          // lets a newer render cancel an older, slower one
let activeUrls = [];          // object URLs to free on the next render
let currentAudio = null;
let clearTimer = null;

const BAR_COUNT = 40;
const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';

function openDrawer() {
  drawerOpen = true;
  drawer.inert = false;
  drawer.classList.add("open");
  backdrop.classList.add("open");
  historyBtn.setAttribute("aria-expanded", "true");
  renderHistory();
  closeBtn.focus();
}

function closeDrawer() {
  drawerOpen = false;
  stopAudio();
  setEditing(false);
  resetClearButton();
  drawer.classList.remove("open");
  backdrop.classList.remove("open");
  drawer.inert = true;
  historyBtn.setAttribute("aria-expanded", "false");
  historyBtn.focus();
}

historyBtn.addEventListener("click", openDrawer);
closeBtn.addEventListener("click", closeDrawer);
backdrop.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && drawerOpen) closeDrawer();
});

/* --- Audio helpers --- */

function stopAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.dispatchEvent(new Event("ended"));   // resets that clip's UI
    currentAudio = null;
  }
}

function formatDuration(seconds) {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

let decodeCtx;
// Decode the recording to get its real length and a loudness profile.
// (Chrome's WebM recordings don't report a duration to <audio>, so we measure it.)
async function analyseRecording(blob) {
  decodeCtx = decodeCtx || new (window.AudioContext || window.webkitAudioContext)();
  const buffer = await decodeCtx.decodeAudioData(await blob.arrayBuffer());
  const data = buffer.getChannelData(0);
  const block = Math.floor(data.length / BAR_COUNT) || 1;

  const peaks = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    let peak = 0;
    for (let j = i * block; j < (i + 1) * block && j < data.length; j++) {
      peak = Math.max(peak, Math.abs(data[j]));
    }
    peaks.push(peak);
  }
  const max = Math.max(...peaks) || 1;
  return { duration: buffer.duration, peaks: peaks.map((p) => p / max) };
}

/* --- Building the list --- */

function buildClip(rec, token) {
  const clip = document.createElement("div");
  clip.className = "clip";

  const play = document.createElement("button");
  play.type = "button";
  play.className = "play";
  play.setAttribute("aria-label", "Play recording");
  play.innerHTML = ICON_PLAY;

  const wave = document.createElement("div");
  wave.className = "wave";
  wave.setAttribute("aria-hidden", "true");
  const bars = Array.from({ length: BAR_COUNT }, () => {
    const bar = document.createElement("span");
    bar.style.height = "12%";
    wave.append(bar);
    return bar;
  });

  const dur = document.createElement("span");
  dur.className = "dur";
  dur.textContent = "–:––";

  clip.append(play, wave, dur);

  let duration = 0;
  analyseRecording(rec.blob)
    .then((info) => {
      if (token !== renderToken) return;
      duration = info.duration;
      dur.textContent = formatDuration(info.duration);
      info.peaks.forEach((p, i) => (bars[i].style.height = `${Math.max(10, p * 100)}%`));
    })
    .catch(() => { dur.textContent = "n/a"; });

  let audio = null;
  const paint = (ratio) =>
    bars.forEach((bar, i) => bar.classList.toggle("played", i < ratio * BAR_COUNT));

  play.addEventListener("click", (e) => {
    e.stopPropagation();   // don't toggle selection while editing

    if (audio && currentAudio === audio) {   // pause if this clip is playing
      stopAudio();
      return;
    }
    stopAudio();

    const url = URL.createObjectURL(rec.blob);
    activeUrls.push(url);
    audio = new Audio(url);
    currentAudio = audio;

    audio.addEventListener("timeupdate", () => {
      if (duration) paint(audio.currentTime / duration);
    });
    audio.addEventListener("ended", () => {
      paint(0);
      play.innerHTML = ICON_PLAY;
      play.setAttribute("aria-label", "Play recording");
      if (currentAudio === audio) currentAudio = null;
    });

    audio.play();
    play.innerHTML = ICON_PAUSE;
    play.setAttribute("aria-label", "Pause recording");
  });

  return clip;
}

function buildEntry(entry, token) {
  const li = document.createElement("li");
  li.className = "entry";
  li.dataset.id = entry.id;
  if (selected.has(entry.id)) li.classList.add("selected");

  const check = document.createElement("span");
  check.className = "check";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = selected.has(entry.id);
  box.setAttribute("aria-label", "Select entry");
  check.append(box);

  const body = document.createElement("div");
  body.className = "entry-body";

  const text = document.createElement("p");
  text.className = "entry-text";
  if (entry.text) {
    text.textContent = entry.text;
  } else {
    text.textContent = "Audio only";
    text.classList.add("muted");
  }

  const time = document.createElement("time");
  time.dateTime = entry.time;
  time.textContent = new Date(entry.time).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

  body.append(text, time);
  (entry.recordings || []).forEach((rec) => body.append(buildClip(rec, token)));

  li.append(check, body);
  return li;
}

async function renderHistory() {
  const token = ++renderToken;
  stopAudio();
  activeUrls.forEach((u) => URL.revokeObjectURL(u));
  activeUrls = [];

  const entries = (await getEntries()).sort((a, b) => b.id - a.id);   // newest first
  if (token !== renderToken) return;

  entryCount = entries.length;
  selected = new Set([...selected].filter((id) => entries.some((e) => e.id === id)));
  listEl.replaceChildren();

  if (!entries.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Nothing saved yet. Type a message or record audio, then press Enter.";
    listEl.append(empty);
  } else {
    entries.forEach((entry) => listEl.append(buildEntry(entry, token)));
  }
  updateFooter();
}

/* --- Edit mode and deleting --- */

function setEditing(on) {
  editing = on;
  if (!on) selected.clear();
  listEl.classList.toggle("editing", on);
  listEl.querySelectorAll(".entry").forEach((li) => {
    li.classList.remove("selected");
    li.querySelector("input").checked = false;
  });
  resetClearButton();
  updateFooter();
}

function toggleSelected(li) {
  const id = Number(li.dataset.id);
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  li.classList.toggle("selected", selected.has(id));
  li.querySelector("input").checked = selected.has(id);
  updateFooter();
}

// Click anywhere on a row (or its checkbox) to select it while editing
listEl.addEventListener("click", (e) => {
  if (!editing) return;
  const li = e.target.closest(".entry");
  if (!li || e.target.closest(".play")) return;
  if (e.target.tagName === "INPUT") {
    // the checkbox already flipped itself; sync our state with it
    const id = Number(li.dataset.id);
    if (e.target.checked) selected.add(id); else selected.delete(id);
    li.classList.toggle("selected", e.target.checked);
    updateFooter();
  } else {
    toggleSelected(li);
  }
});

function updateFooter() {
  if (editing) {
    editBtn.textContent = "Done";
    editBtn.disabled = false;
    clearBtn.textContent = selected.size ? `Delete selected (${selected.size})` : "Delete selected";
    clearBtn.disabled = selected.size === 0;
  } else {
    editBtn.textContent = "Edit";
    editBtn.disabled = entryCount === 0;
    clearBtn.textContent = "Clear all history";
    clearBtn.disabled = entryCount === 0;
  }
}

function resetClearButton() {
  clearTimeout(clearTimer);
  clearTimer = null;
  updateFooter();
}

editBtn.addEventListener("click", () => setEditing(!editing));

clearBtn.addEventListener("click", async () => {
  if (editing) {
    await deleteEntries([...selected]);
    selected.clear();
    await renderHistory();
    if (entryCount === 0) setEditing(false);
    return;
  }

  // "Clear all" needs a second click to confirm
  if (!clearTimer) {
    clearBtn.textContent = "Click again to confirm";
    clearTimer = setTimeout(resetClearButton, 3000);
    return;
  }
  resetClearButton();
  await clearAllData();
  await renderHistory();
});