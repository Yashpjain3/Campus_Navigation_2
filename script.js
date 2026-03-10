/* ============================================================
   Campus Navigator — script.js
   No ngrok needed. Works via Render (https) deployment.
   ============================================================ */

let session_id    = null;
let watchId       = null;
let totalSteps    = 0;
let currentStep   = 0;
let destName      = "";

/* ------------------------------------------------------------------ */
/*  POPULATE DROPDOWNS FROM SERVER                                     */
/* ------------------------------------------------------------------ */

async function loadLocations() {
  try {
    const res  = await fetch("/locations");
    const data = await res.json();

    const startSel = document.getElementById("start-select");
    const destSel  = document.getElementById("dest-select");

    data.forEach(loc => {
      const o1 = new Option(loc.name, loc.id);
      const o2 = new Option(loc.name, loc.id);
      startSel.appendChild(o1);
      destSel.appendChild(o2);
    });

    // Enable start button when both selects have a value
    [startSel, destSel].forEach(sel => {
      sel.addEventListener("change", () => {
        const ok = startSel.value && destSel.value && startSel.value !== destSel.value;
        document.getElementById("start-btn").disabled = !ok;
      });
    });

  } catch (e) {
    setGpsStatus("error", "Could not load campus data.");
  }
}

/* ------------------------------------------------------------------ */
/*  GPS STATUS HELPERS                                                 */
/* ------------------------------------------------------------------ */

function setGpsStatus(state, msg) {
  const dot  = document.getElementById("gps-dot");
  const text = document.getElementById("gps-text");
  dot.className  = "gps-dot " + state;
  text.innerText = msg;
}

/* ------------------------------------------------------------------ */
/*  VOICE GUIDANCE                                                     */
/* ------------------------------------------------------------------ */

function speak(text) {
  const voiceOn = document.getElementById("voice-toggle").checked;
  if (!voiceOn || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang  = "en-IN";
  utt.rate  = 0.95;
  window.speechSynthesis.speak(utt);
}

/* ------------------------------------------------------------------ */
/*  PAGE LOAD                                                          */
/* ------------------------------------------------------------------ */

window.onload = function () {

  if (!navigator.geolocation) {
    setGpsStatus("error", "Geolocation not supported on this device.");
    return;
  }

  setGpsStatus("waiting", "Waiting for GPS permission...");
  loadLocations();

};

/* ------------------------------------------------------------------ */
/*  START NAVIGATION                                                   */
/* ------------------------------------------------------------------ */

async function startNavigation() {

  const start = document.getElementById("start-select").value;
  const dest  = document.getElementById("dest-select").value;
  destName    = document.getElementById("dest-select").selectedOptions[0].text;

  if (!start || !dest) return;

  document.getElementById("start-btn").disabled = true;
  setGpsStatus("waiting", "Starting navigation...");

  try {
    const res  = await fetch("/start_navigation", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ start, destination: dest })
    });
    const data = await res.json();

    if (data.error) {
      setGpsStatus("error", "Error: " + data.error);
      document.getElementById("start-btn").disabled = false;
      return;
    }

    session_id  = data.session_id;
    totalSteps  = data.route.length - 1;
    currentStep = 0;

    // Switch to nav card
    document.getElementById("setup-card").style.display = "none";
    document.getElementById("nav-card").style.display   = "block";
    document.getElementById("instruction-box").style.display = "block";
    document.getElementById("stop-btn").style.display   = "block";

    updateProgress(0);
    speak("Navigation started. Head towards " + destName);
    setGpsStatus("waiting", "Acquiring GPS signal...");

    // Start watching GPS
    watchId = navigator.geolocation.watchPosition(
      sendLocation,
      gpsError,
      {
        enableHighAccuracy: true,
        maximumAge:         0,
        timeout:            30000   // 30s — enough for cold GPS start outdoors
      }
    );

  } catch (e) {
    setGpsStatus("error", "Server connection failed.");
    document.getElementById("start-btn").disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/*  SEND GPS TO SERVER                                                 */
/* ------------------------------------------------------------------ */

async function sendLocation(position) {

  const lat = position.coords.latitude;
  const lng = position.coords.longitude;

  setGpsStatus("active", "GPS active · Tracking...");

  try {
    const res  = await fetch("/update_location", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ session_id, lat, lng })
    });
    const data = await res.json();

    if (data.error) {
      setGpsStatus("error", "Session error.");
      return;
    }

    // Navigation complete
    if (data.instruction === "Navigation complete.") {
      showArrived();
      return;
    }

    const instruction = data.instruction;
    const distance    = Math.round(data.distance);
    const step        = data.step ?? currentStep;

    // Update UI
    if (instruction !== document.getElementById("instruction-text").innerText) {
      speak(instruction);
    }

    document.getElementById("instruction-text").innerText = instruction;
    document.getElementById("distance-text").innerText    = distance + " m";
    document.getElementById("step-badge").innerText       = "STEP " + (step + 1);

    currentStep = step;
    updateProgress(step);

  } catch (e) {
    setGpsStatus("error", "Connection lost. Retrying...");
  }
}

/* ------------------------------------------------------------------ */
/*  PROGRESS BAR                                                       */
/* ------------------------------------------------------------------ */

function updateProgress(step) {
  const pct = totalSteps > 0 ? Math.round((step / totalSteps) * 100) : 0;
  document.getElementById("progress-fill").style.width  = pct + "%";
  document.getElementById("step-counter").innerText     = step + " / " + totalSteps + " steps";
}

/* ------------------------------------------------------------------ */
/*  ARRIVED                                                            */
/* ------------------------------------------------------------------ */

function showArrived() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  document.getElementById("instruction-box").style.display = "none";
  document.getElementById("arrived-box").style.display     = "block";
  document.getElementById("arrived-name").innerText        = "You have reached " + destName;
  document.getElementById("stop-btn").style.display        = "none";
  document.getElementById("progress-fill").style.width     = "100%";
  setGpsStatus("active", "Arrived at destination.");
  speak("You have arrived at " + destName);
}

/* ------------------------------------------------------------------ */
/*  STOP NAVIGATION                                                    */
/* ------------------------------------------------------------------ */

function stopNavigation() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  session_id = null;
  document.getElementById("nav-card").style.display        = "none";
  document.getElementById("setup-card").style.display      = "block";
  document.getElementById("arrived-box").style.display     = "none";
  document.getElementById("instruction-box").style.display = "block";
  document.getElementById("start-btn").disabled            = false;
  setGpsStatus("waiting", "Navigation stopped.");
  speak("Navigation stopped.");
}

/* ------------------------------------------------------------------ */
/*  GPS ERROR                                                          */
/* ------------------------------------------------------------------ */

function gpsError(error) {
  const msgs = {
    1: "Location permission denied. Allow it in browser settings.",
    2: "GPS signal unavailable. Move to an open area.",
    3: "GPS timed out. Move outdoors and try again."
  };
  setGpsStatus("error", msgs[error.code] || "Unknown GPS error.");
}
