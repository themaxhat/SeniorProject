/* =====================================================================
   AI Counselor — main app logic
   ---------------------------------------------------------------------
   1. Local storage (IndexedDB)        6. History drawer + tabs
   2. Chat thread (left panel)         7. Edit mode and deleting
   3. Recording audio (the orb)        8. Export
   4. Enter saves the text             9. HOOKS for the AI / STT / TTS team
   5. Console helpers
   Layout, background, greeting and the microphone lock live in ui.js.
   ===================================================================== */


/* ---------- 1. Local storage (IndexedDB) ----------
   Data stays in this browser on this computer. Nothing is sent anywhere.
   IndexedDB can store audio files (Blobs) directly, unlike localStorage.

   Database "chat-db" / store "entries" / keyPath "id" is unchanged.
   Entries now carry ONE extra optional field, `chatId`, so history can be
   grouped into chats. Entries saved before this field existed have no
   chatId and are shown as "Earlier messages". */

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

// Show a message, then clear it (unless something newer replaced it)
function flashStatus(message, ms = 1800) {
  setStatus(message);
  setTimeout(() => { if (statusEl.textContent === message) setStatus(""); }, ms);
}

/* A chat is a group of entries that share a chatId.
   currentChatId === undefined means "the Earlier messages group". */
const newChatId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
let currentChatId = newChatId();

function makeEntry(text, recordings, chatId = currentChatId) {
  const entry = { text, recordings, time: new Date().toISOString() };
  if (chatId) entry.chatId = chatId;
  return entry;
}


/* ---------- 2. Chat thread (left panel) ----------
   Shows the messages of the current chat as bubbles. Your own messages are
   blue and on the right; replies from the assistant are grey and on the
   left. Assistant replies are shown but not saved (see section 9). */

const threadEl = document.getElementById("thread");
const EMPTY_THREAD_TEXT = "Your conversation will appear here. Type below, or select the orb to talk.";
const ICON_MIC_SMALL = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4"/></svg>';

function updateThreadEmpty() {
  const hasBubbles = threadEl.querySelector(".bubble");
  let empty = threadEl.querySelector(".thread-empty");
  if (hasBubbles && empty) empty.remove();
  if (!hasBubbles && !empty) {
    empty = document.createElement("p");
    empty.className = "thread-empty";
    empty.textContent = EMPTY_THREAD_TEXT;
    threadEl.append(empty);
  }
}

// kind: "user" | "assistant" | "voice"
function addBubble(kind, text, entryId) {
  const bubble = document.createElement("div");
  bubble.className = `bubble ${kind === "assistant" ? "bubble-assistant" : "bubble-user"}`;
  if (kind === "voice") {
    bubble.classList.add("bubble-voice");
    bubble.innerHTML = ICON_MIC_SMALL;
    bubble.append(document.createTextNode("Voice recording"));
  } else {
    bubble.textContent = text;
  }
  if (entryId !== undefined) bubble.dataset.entryId = entryId;
  threadEl.append(bubble);
  updateThreadEmpty();
  threadEl.scrollTop = threadEl.scrollHeight;
  return bubble;
}

function renderEntriesAsBubbles(entries) {
  threadEl.replaceChildren();
  entries.forEach((entry) => {
    if (entry.text) addBubble("user", entry.text, entry.id);
    (entry.recordings || []).forEach(() => addBubble("voice", "", entry.id));
  });
  updateThreadEmpty();
}

function startNewChat() {
  currentChatId = newChatId();
  threadEl.replaceChildren();
  updateThreadEmpty();
  input.value = "";
  setStatus("");
  input.focus();
}

document.getElementById("new-chat").addEventListener("click", startNewChat);
updateThreadEmpty();


/* ---------- 3. Recording audio (MediaRecorder) ----------
   The orb is the record button: select it to start, again to stop.
   Each recording is saved as its own entry as soon as it stops. */

const micBtn = document.getElementById("mic");
const transcriptEl = document.getElementById("transcript");
const TRANSCRIPT_PLACEHOLDER = transcriptEl.textContent;
const LISTENING_TEXT = "Listening… select the orb again when you’re done.";
const MAX_RECORDING_SECONDS = 300;      // safety net so a forgotten mic doesn't record forever

let recorder = null;
let starting = false;                   // true while the browser permission prompt is open
let recordingTimer = null;
let limitTimer = null;
let stopReason = null;                  // "limit" | "lock" | null

const micLocked = () => window.CounselorUI?.isMicLocked?.() === true;

function setRecordingUI(on) {
  micBtn.classList.toggle("listening", on);          // the orb shrinks while recording
  micBtn.setAttribute("aria-pressed", String(on));
  micBtn.setAttribute("aria-label", on ? "Stop recording" : "Start recording");
  document.body.classList.toggle("is-recording", on);
}

function stopRecordingTimers() {
  clearInterval(recordingTimer);
  clearTimeout(limitTimer);
  recordingTimer = limitTimer = null;
}

async function startRecording() {
  if (micLocked()) {
    setStatus("The microphone is turned off. Use the microphone button at the top right to turn it on.");
    window.CounselorUI?.flashMicLock?.();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    setStatus("This browser can’t record audio. Try a recent version of Chrome, Edge, Firefox or Safari.");
    return;
  }

  starting = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // The lock may have been switched on while the permission prompt was open
    if (micLocked()) {
      stream.getTracks().forEach((t) => t.stop());
      setStatus("The microphone is turned off.");
      return;
    }

    const chunks = [];
    const rec = new MediaRecorder(stream);
    const chatIdAtStart = currentChatId;
    recorder = rec;

    rec.ondataavailable = (e) => chunks.push(e.data);

    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());   // release the mic
      stopRecordingTimers();
      setRecordingUI(false);
      setTranscript("");
      if (recorder === rec) recorder = null;
      const reason = stopReason;
      stopReason = null;

      const blob = new Blob(chunks, { type: rec.mimeType });
      if (!blob.size) return setStatus("");

      try {
        const entry = makeEntry(
          "",
          [{ blob, type: blob.type, recordedAt: new Date().toISOString() }],
          chatIdAtStart
        );
        const entryId = await addEntry(entry);
        if (currentChatId === chatIdAtStart) addBubble("voice", "", entryId);
        if (drawerOpen) renderHistory();
        document.dispatchEvent(new CustomEvent("counselor:recording-saved", {
          detail: { entryId, chatId: chatIdAtStart, blob },
        }));
        const note = reason === "limit" ? "Recording saved. It reached the 5-minute limit."
                   : reason === "lock" ? "Microphone turned off. Your recording was saved."
                   : "Recording saved.";
        flashStatus(note, 3500);
      } catch (err) {
        console.warn("Save error:", err);
        setStatus("Couldn’t save the recording. Your browser’s storage may be full.");
      }
    };

    rec.start();
    setRecordingUI(true);
    setTranscript(LISTENING_TEXT);

    const startedAt = Date.now();
    const tick = () => setStatus(`Recording… ${formatDuration((Date.now() - startedAt) / 1000)} · select the orb to stop.`);
    tick();
    recordingTimer = setInterval(tick, 1000);
    limitTimer = setTimeout(() => { stopReason = "limit"; if (recorder === rec) rec.stop(); }, MAX_RECORDING_SECONDS * 1000);
  } catch (err) {
    console.warn("Mic error:", err);
    const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
    setStatus(denied
      ? "Microphone access was blocked. Allow it in your browser’s site settings, then try again."
      : "Couldn’t access the microphone. Check that one is connected and not in use by another app.");
  } finally {
    starting = false;
  }
}

micBtn.addEventListener("click", () => {
  if (recorder) recorder.stop();
  else if (!starting) startRecording();
});

// Turning the microphone off in the app ends any recording that is in progress
document.addEventListener("counselor:mic-lock-changed", (e) => {
  if (e.detail?.locked && recorder) {
    stopReason = "lock";
    recorder.stop();
  }
});


/* ---------- 4. Enter saves the text ---------- */

input.addEventListener("keydown", async (e) => {
  if (e.key !== "Enter" || e.isComposing) return;

  const text = input.value.trim();
  if (!text) { input.value = ""; return; }     // spaces only: nothing to save, show the hint again

  try {
    const chatId = currentChatId;
    const entryId = await addEntry(makeEntry(text, [], chatId));

    input.value = "";
    addBubble("user", text, entryId);
    if (drawerOpen) renderHistory();
    flashStatus("Saved.");
    document.dispatchEvent(new CustomEvent("counselor:user-message", {
      detail: { text, chatId, entryId },
    }));
  } catch (err) {
    console.warn("Save error:", err);
    setStatus("Couldn’t save your message. Your browser’s storage may be full.");
  }
});


/* ---------- 5. Reading saved data back (try these in the console) ----------
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


/* ---------- 6. History drawer + tabs ----------
   Chats tab:      one row per chat; select a row to load it into the thread.
   Recordings tab: every saved recording, with waveform, length and playback.
   (Later, when recordings are saved as transcribed chats, they will appear
   under Chats like any other chat.) */

const drawer = document.getElementById("history");
const backdrop = document.getElementById("backdrop");
const historyBtn = document.getElementById("history-btn");
const closeBtn = document.getElementById("history-close");
const listEl = document.getElementById("history-list");
const editBtn = document.getElementById("edit-btn");
const clearBtn = document.getElementById("clear-btn");
const exportBtn = document.getElementById("export-btn");
const noteEl = document.getElementById("drawer-note");
const tabButtons = { chats: document.getElementById("tab-chats"), recordings: document.getElementById("tab-recordings") };

let drawerOpen = false;
let editing = false;
let activeTab = "chats";
let selected = new Set();     // row keys, e.g. "r:12" (recording) or "c:abc123" (chat)
let rowIds = new Map();       // row key -> the entry ids that row stands for
let entryCount = 0;           // rows in the current tab
let totalEntries = 0;         // every saved entry, both tabs
let renderToken = 0;          // lets a newer render cancel an older, slower one
let activeUrls = [];          // object URLs to free on the next render
let currentAudio = null;
let clearTimer = null;
let noteTimer = null;

const BAR_COUNT = 40;
const LEGACY_KEY = "c:legacy";
const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';

function drawerNote(message) {
  clearTimeout(noteTimer);
  noteEl.textContent = message;
  if (message) noteTimer = setTimeout(() => { noteEl.textContent = ""; }, 4000);
}

function openDrawer() {
  drawerOpen = true;
  drawer.inert = false;
  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  backdrop.classList.add("open");
  historyBtn.setAttribute("aria-expanded", "true");
  showTab("chats");               // always start on Chats: that is where people go to find old conversations
  renderHistory();
  closeBtn.focus();
}

function closeDrawer() {
  drawerOpen = false;
  stopAudio();
  setEditing(false);
  resetClearButton();
  drawerNote("");
  drawer.classList.remove("open");
  backdrop.classList.remove("open");
  drawer.inert = true;
  drawer.setAttribute("aria-hidden", "true");
  historyBtn.setAttribute("aria-expanded", "false");
  historyBtn.focus();
}

historyBtn.addEventListener("click", openDrawer);
closeBtn.addEventListener("click", closeDrawer);
backdrop.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && drawerOpen) closeDrawer();
});

// ui.js asks for this when the chat panel is minimized while the drawer is open
document.addEventListener("counselor:chat-collapsing", () => { if (drawerOpen) closeDrawer(); });

function showTab(tab) {
  activeTab = tab;
  Object.entries(tabButtons).forEach(([name, btn]) => btn.setAttribute("aria-selected", String(name === tab)));
}

function setTab(tab) {
  if (tab === activeTab) return;
  showTab(tab);
  setEditing(false);
  renderHistory();
}
tabButtons.chats.addEventListener("click", () => setTab("chats"));
tabButtons.recordings.addEventListener("click", () => setTab("recordings"));

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

// Shared row frame: checkbox + body. `key` identifies the row for selection.
function buildRow(key, ids, bodyChildren, label) {
  rowIds.set(key, ids);

  const li = document.createElement("li");
  li.className = "entry";
  li.dataset.key = key;
  if (selected.has(key)) li.classList.add("selected");

  const check = document.createElement("span");
  check.className = "check";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = selected.has(key);
  box.setAttribute("aria-label", label);
  check.append(box);

  const body = document.createElement("div");
  body.className = "entry-body";
  body.append(...bodyChildren);

  li.append(check, body);
  return li;
}

function timeEl(iso) {
  const time = document.createElement("time");
  time.dateTime = iso;
  time.textContent = new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  return time;
}

// Recordings tab: one row per entry that has audio
function buildEntry(entry, token) {
  const children = [];
  (entry.recordings || []).forEach((rec) => children.push(buildClip(rec, token)));

  if (entry.text) {
    const text = document.createElement("p");
    text.className = "entry-text";
    text.textContent = entry.text;
    children.push(text);
  }
  children.push(timeEl(entry.time));

  return buildRow(`r:${entry.id}`, [entry.id], children, "Select recording");
}

// Chats tab: one row per chat
function groupChats(entries) {
  const groups = new Map();
  entries.forEach((entry) => {
    const isLegacy = !entry.chatId;
    if (isLegacy && (entry.recordings || []).length) return;   // old recordings live in the Recordings tab
    const key = isLegacy ? LEGACY_KEY : `c:${entry.chatId}`;
    if (!groups.has(key)) groups.set(key, { key, legacy: isLegacy, entries: [] });
    groups.get(key).entries.push(entry);
  });
  groups.forEach((g) => g.entries.sort((a, b) => a.id - b.id));
  return [...groups.values()].sort((a, b) => b.entries.at(-1).id - a.entries.at(-1).id);   // newest first
}

function buildChatRow(group) {
  const first = group.entries[0];
  const last = group.entries.at(-1);

  const open = document.createElement("button");
  open.type = "button";
  open.className = "chat-open";

  const title = document.createElement("span");
  title.className = "entry-text";
  title.textContent = group.legacy ? "Earlier messages"
    : (group.entries.find((e) => e.text)?.text || "Voice recording");

  const meta = document.createElement("span");
  meta.className = "chat-meta";
  const count = group.entries.length;
  meta.textContent = `${count} ${count === 1 ? "message" : "messages"}`;

  open.append(title, timeEl(last.time), meta);
  return buildRow(group.key, group.entries.map((e) => e.id), [open], `Select chat: ${title.textContent}`);
}

async function renderHistory() {
  const token = ++renderToken;
  stopAudio();
  activeUrls.forEach((u) => URL.revokeObjectURL(u));
  activeUrls = [];

  const all = await getEntries();
  if (token !== renderToken) return;

  totalEntries = all.length;
  rowIds = new Map();
  listEl.replaceChildren();

  let rows;
  if (activeTab === "recordings") {
    const withAudio = all.filter((e) => (e.recordings || []).length).sort((a, b) => b.id - a.id);
    rows = withAudio.map((entry) => buildEntry(entry, token));
  } else {
    rows = groupChats(all).map(buildChatRow);
  }

  entryCount = rows.length;
  selected = new Set([...selected].filter((key) => rowIds.has(key)));

  if (!rows.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = activeTab === "recordings"
      ? "No recordings yet. Select the orb to record something."
      : "No chats yet. Type a message to start one.";
    listEl.append(empty);
  } else {
    listEl.append(...rows);
  }
  updateFooter();
}

// Open a saved chat in the left panel so it can be read and continued
async function loadChat(key) {
  const all = await getEntries();
  const isLegacy = key === LEGACY_KEY;
  const chatId = isLegacy ? undefined : key.slice(2);

  const entries = all
    .filter((e) => (isLegacy ? !e.chatId && !(e.recordings || []).length : e.chatId === chatId))
    .sort((a, b) => a.id - b.id);

  currentChatId = chatId;
  renderEntriesAsBubbles(entries);
  closeDrawer();
  window.CounselorUI?.openChat?.();
}


/* ---------- 7. Edit mode and deleting ---------- */

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
  const key = li.dataset.key;
  if (selected.has(key)) selected.delete(key);
  else selected.add(key);
  li.classList.toggle("selected", selected.has(key));
  li.querySelector("input").checked = selected.has(key);
  updateFooter();
}

listEl.addEventListener("click", (e) => {
  const li = e.target.closest(".entry");
  if (!li) return;

  // Not editing: selecting a chat row opens that chat
  if (!editing) {
    if (e.target.closest(".chat-open")) loadChat(li.dataset.key);
    return;
  }

  // Editing: click anywhere on a row (or its checkbox) to select it
  if (e.target.closest(".play")) return;
  if (e.target.tagName === "INPUT") {
    // the checkbox already flipped itself; sync our state with it
    const key = li.dataset.key;
    if (e.target.checked) selected.add(key); else selected.delete(key);
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
    clearBtn.disabled = totalEntries === 0;
  }
  exportBtn.disabled = totalEntries === 0;
}

function resetClearButton() {
  clearTimeout(clearTimer);
  clearTimer = null;
  updateFooter();
}

// After deleting, keep the thread in step with what is actually saved
function syncThreadAfterDelete(deletedKeys, deletedIds) {
  const currentKey = currentChatId ? `c:${currentChatId}` : LEGACY_KEY;
  if (deletedKeys.includes(currentKey)) return startNewChat();
  threadEl.querySelectorAll(".bubble[data-entry-id]").forEach((b) => {
    if (deletedIds.includes(Number(b.dataset.entryId))) b.remove();
  });
  updateThreadEmpty();
}

editBtn.addEventListener("click", () => setEditing(!editing));

clearBtn.addEventListener("click", async () => {
  if (editing) {
    const keys = [...selected];
    const ids = keys.flatMap((key) => rowIds.get(key) || []);
    try {
      await deleteEntries(ids);
    } catch (err) {
      console.warn("Delete error:", err);
      return drawerNote("Couldn’t delete the selected items.");
    }
    selected.clear();
    syncThreadAfterDelete(keys, ids);
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
  startNewChat();
  await renderHistory();
});


/* ---------- 8. Export ----------
   Downloads every chat and recording as one JSON file (audio is embedded
   as base64), a backup in case the browser ever clears its storage. */

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

exportBtn.addEventListener("click", async () => {
  try {
    const entries = await getEntries();
    if (!entries.length) return drawerNote("Nothing to export yet.");
    drawerNote("Preparing your export…");

    const out = [];
    for (const entry of entries) {
      const recordings = await Promise.all((entry.recordings || []).map(async (r) => ({
        type: r.type,
        recordedAt: r.recordedAt,
        dataUrl: await blobToDataUrl(r.blob),
      })));
      out.push({ ...entry, recordings });
    }

    const file = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), entries: out }, null, 2)],
      { type: "application/json" });
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = `counselor-history-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    drawerNote("History exported.");
  } catch (err) {
    console.warn("Export error:", err);
    drawerNote("Couldn’t export your history.");
  }
});


/* ---------- 9. HOOKS for the AI agent, speech-to-text and text-to-speech ----------
   Nothing below calls a server. These are the places your teammates connect.

   Events fired by this file (listen with document.addEventListener):
     "counselor:user-message"   detail: { text, chatId, entryId }      after a typed message is saved
     "counselor:recording-saved" detail: { entryId, chatId, blob }     after a recording is saved
     "counselor:mic-lock-changed" detail: { locked }                   (fired by ui.js)

   Functions you can call:
     addAssistantMessage(text)  adds a grey assistant bubble to the thread (display only, not saved)
     setTranscript(text)        fills the "live transcription" box; setTranscript("") restores the hint */

function addAssistantMessage(text) {
  return addBubble("assistant", text);
}

function setTranscript(text = "") {
  const has = Boolean(text);
  transcriptEl.textContent = has ? text : TRANSCRIPT_PLACEHOLDER;
  transcriptEl.classList.toggle("is-placeholder", !has);
}
