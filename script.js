/* ============================================================
   Campus Navigator — script.js
   Leaflet map | Arrow marker | Completed/remaining route
   Satellite toggle | Voice | GPS current location
   ============================================================ */

/* ------------------------------------------------------------------ */
/*  CAMPUS NODE COORDINATES (embedded for map use)                    */
/* ------------------------------------------------------------------ */

const CAMPUS_NODES = {
  "loc_001":{"name":"Admin Block","lat":12.313145671732428,"lng":76.61363978851972},
  "loc_002":{"name":"Chemistry Department","lat":12.314014207480326,"lng":76.61368252764498},
  "loc_003":{"name":"Environment Department","lat":12.314687880254084,"lng":76.61341994021609},
  "loc_004":{"name":"Polymer Science Department","lat":12.315299754396065,"lng":76.61354313249961},
  "loc_005":{"name":"Golden Jubilee Block","lat":12.316367938062982,"lng":76.61376993999346},
  "loc_006":{"name":"CMS Block","lat":12.317764881241672,"lng":76.61395179750588},
  "loc_007":{"name":"PDA Block","lat":12.31745506474995,"lng":76.61339054456158},
  "loc_008":{"name":"Rubber Institute","lat":12.315472888795625,"lng":76.61205742767464},
  "loc_009":{"name":"Mechanical Auditorium","lat":12.3142736628307,"lng":76.61273353193718},
  "loc_010":{"name":"Mechanical Department","lat":12.313944483210562,"lng":76.6127632054476},
  "loc_011":{"name":"Electrical and Electronics Department","lat":12.313166648613944,"lng":76.61283634345875},
  "loc_012":{"name":"Ganesha Temple","lat":12.312978131420465,"lng":76.6128603005481},
  "loc_013":{"name":"Pot Circle","lat":12.313031367737949,"lng":76.61419057219899},
  "loc_014":{"name":"Department of Physical Training","lat":12.312303099811686,"lng":76.61387392725118},
  "loc_015":{"name":"Boys Hostel","lat":12.31254368461778,"lng":76.61388169523116},
  "loc_016":{"name":"Entrance Gate","lat":12.313123610989763,"lng":76.61521067151989},
  "loc_017":{"name":"Polytechnic For Women","lat":12.318405364318124,"lng":76.61407797369316},
  "loc_018":{"name":"SJCE Women Hostel","lat":12.318612496708994,"lng":76.61128672355323},
  "loc_019":{"name":"Exit Gate","lat":12.318467376926534,"lng":76.6146825207772},
  "loc_020":{"name":"Circle Towards Exit","lat":12.318373979158878,"lng":76.61353321972155},
  "loc_021":{"name":"CS Lawn Circle","lat":12.315590917586988,"lng":76.6136658685898},
  "loc_022":{"name":"Hockey Ground","lat":12.313702611648196,"lng":76.61410073906313},
  "loc_023":{"name":"Football Ground","lat":12.314802127329855,"lng":76.61395961101715},
  "loc_024":{"name":"Dean Office Circle","lat":12.313018964956285,"lng":76.61392597878137},
  "loc_025":{"name":"Basketball Court","lat":12.312696986912485,"lng":76.61422199865103},
  "loc_026":{"name":"Gymnasium","lat":12.312167826400568,"lng":76.6142756159552},
  "loc_027":{"name":"Chemistry Circle","lat":12.314353981650783,"lng":76.61364762703806},
  "loc_028":{"name":"Department of Civil Engineering","lat":12.314320658153463,"lng":76.61331231625559},
  "loc_029":{"name":"Department of Biotechnology","lat":12.314754304519028,"lng":76.61267958318854}
};

/* ------------------------------------------------------------------ */
/*  STATE                                                              */
/* ------------------------------------------------------------------ */

let session_id      = null;
let watchId         = null;
let totalSteps      = 0;
let currentStep     = 0;
let destName        = "";
let allLocations    = [];
let lastInstruction = "";
let lastSpokenStep  = -1;
let lastSpokenDist  = -1;
let spokenMilestones = new Set();

let lastLat     = null;
let lastLng     = null;
let userHeading = -1;
let compassHeading = -1;  // from device orientation sensor

// Use phone compass if available (works even when standing still)
function startCompass() {
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    // iOS 13+ requires permission
    DeviceOrientationEvent.requestPermission().then(state => {
      if (state === 'granted') listenOrientation();
    }).catch(() => {});
  } else {
    listenOrientation();
  }
}

function listenOrientation() {
  window.addEventListener('deviceorientationabsolute', handleOrientation, true);
  window.addEventListener('deviceorientation', handleOrientation, true);
}

function handleOrientation(e) {
  let heading = null;
  if (e.webkitCompassHeading !== undefined && e.webkitCompassHeading !== null) {
    heading = e.webkitCompassHeading;           // iOS
  } else if (e.absolute && e.alpha !== null) {
    heading = (360 - e.alpha) % 360;            // Android absolute
  }
  if (heading !== null && !isNaN(heading)) {
    compassHeading = heading;
    userHeading = heading;  // prefer compass over GPS movement heading
  }
}

// Full route node IDs for map drawing
let routeNodeIds  = [];
let roadGeometry  = [];  // per-step road waypoints from server

/* ------------------------------------------------------------------ */
/*  MAP SETUP                                                          */
/* ------------------------------------------------------------------ */

let map, streetLayer, satelliteLayer, isSatellite = false;
let arrowMarker    = null;   // user position arrow
let routeRemaining = null;   // blue polyline
let routeCompleted = null;   // grey polyline
let waypointMarkers = [];    // dots on each node
let userCentered   = true;   // auto-pan flag

function initMap() {
  // Centre on SJCE campus
  map = L.map("map", {
    center: [12.3148, 76.6137],
    zoom: 17,
    zoomControl: true,
    attributionControl: false
  });

  // Street layer (OpenStreetMap)
  streetLayer = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    { maxZoom: 20 }
  ).addTo(map);

  // Satellite layer (ESRI World Imagery)
  satelliteLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 20 }
  );

  // Plot all campus nodes as small dots (non-nav mode)
  Object.entries(CAMPUS_NODES).forEach(([id, node]) => {
    const dot = L.divIcon({
      className: "",
      html: `<div class="waypoint-dot" style="opacity:0.5"></div>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6]
    });
    L.marker([node.lat, node.lng], { icon: dot })
      .bindPopup(`<b>${node.name}</b>`)
      .addTo(map);
  });

  // Detect user panning away — disable auto-center
  map.on("dragstart", () => {
    userCentered = false;
    document.getElementById("recenter-btn").classList.add("show");
  });
}

function toggleMapLayer() {
  const btn = document.getElementById("map-toggle");
  if (isSatellite) {
    map.removeLayer(satelliteLayer);
    streetLayer.addTo(map);
    btn.textContent = "🛰 SATELLITE";
    isSatellite = false;
  } else {
    map.removeLayer(streetLayer);
    satelliteLayer.addTo(map);
    btn.textContent = "🗺 STREET";
    isSatellite = true;
  }
}

function recenterMap() {
  if (lastLat !== null) {
    map.setView([lastLat, lastLng], 18);
    userCentered = true;
    document.getElementById("recenter-btn").classList.remove("show");
  }
}

/* ------------------------------------------------------------------ */
/*  ARROW MARKER (direction of movement)                              */
/* ------------------------------------------------------------------ */

function createArrowIcon(heading) {
  const h = heading >= 0 ? heading : 0;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
      <circle cx="18" cy="18" r="14" fill="#00d4ff" fill-opacity="0.25" stroke="#00d4ff" stroke-width="1.5"/>
      <circle cx="18" cy="18" r="7"  fill="#00d4ff"/>
      <polygon points="18,4 22,16 18,13 14,16"
               fill="white" transform="rotate(${h}, 18, 18)"/>
    </svg>`;
  return L.divIcon({
    className: "",
    html: svg,
    iconSize: [36, 36],
    iconAnchor: [18, 18]
  });
}

function updateArrowMarker(lat, lng, heading) {
  const icon = createArrowIcon(heading);
  if (!arrowMarker) {
    arrowMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 }).addTo(map);
  } else {
    arrowMarker.setLatLng([lat, lng]);
    arrowMarker.setIcon(icon);
  }
  if (userCentered) {
    map.setView([lat, lng], map.getZoom());
  }
}

/* ------------------------------------------------------------------ */
/*  ROUTE DRAWING                                                      */
/* ------------------------------------------------------------------ */

function drawRoute(nodeIds, completedUpTo) {
  // Clear existing lines and markers
  if (routeRemaining) { map.removeLayer(routeRemaining); routeRemaining = null; }
  if (routeCompleted) { map.removeLayer(routeCompleted); routeCompleted = null; }
  waypointMarkers.forEach(m => map.removeLayer(m));
  waypointMarkers = [];

  if (nodeIds.length < 2) return;

  // Build full route coords using real road waypoints where available,
  // falling back to straight line between nodes
  function getSegmentCoords(stepIdx) {
    const fromId = nodeIds[stepIdx];
    const toId   = nodeIds[stepIdx + 1];
    const wps    = roadGeometry[stepIdx];         // [[lat,lng], ...]
    if (wps && wps.length >= 2) return wps;       // real road geometry
    // Fallback: straight line between the two nodes
    const a = CAMPUS_NODES[fromId], b = CAMPUS_NODES[toId];
    if (!a || !b) return [];
    return [[a.lat, a.lng], [b.lat, b.lng]];
  }

  // Split into completed and remaining segments
  const doneCoords = [];
  const leftCoords = [];

  for (let i = 0; i < nodeIds.length - 1; i++) {
    const seg = getSegmentCoords(i);
    if (i < completedUpTo) {
      doneCoords.push(...seg);
    } else {
      // Include last done node as start of remaining so lines connect
      if (leftCoords.length === 0 && doneCoords.length > 0) {
        leftCoords.push(doneCoords[doneCoords.length - 1]);
      }
      leftCoords.push(...seg);
    }
  }

  // Draw completed path — grey dashed
  if (doneCoords.length >= 2) {
    routeCompleted = L.polyline(doneCoords, {
      color: "#4a5568", weight: 4, opacity: 0.7, dashArray: "6 6"
    }).addTo(map);
  }

  // Draw remaining path — bright blue
  if (leftCoords.length >= 2) {
    routeRemaining = L.polyline(leftCoords, {
      color: "#00d4ff", weight: 6, opacity: 0.95
    }).addTo(map);
  }

  // Waypoint dots at each node
  nodeIds.forEach((id, idx) => {
    const n = CAMPUS_NODES[id];
    if (!n) return;
    const isDone = idx < completedUpTo;
    const isDest = idx === nodeIds.length - 1;
    const isNext = idx === completedUpTo + 1;

    let cls = "waypoint-dot";
    if (isDone) cls += " done";
    if (isDest) cls += " dest";

    const size = isDest ? [16,16] : [12,12];
    const anchor = isDest ? [8,8] : [6,6];

    const dotIcon = L.divIcon({
      className: "",
      html: `<div class="${cls}"></div>`,
      iconSize: size, iconAnchor: anchor
    });

    const m = L.marker([n.lat, n.lng], { icon: dotIcon })
      .bindPopup(`<b>${n.name}</b>${isDest ? "<br><i>🏁 Destination</i>" : ""}${isNext ? "<br><i>▶ Next waypoint</i>" : ""}`)
      .addTo(map);
    waypointMarkers.push(m);
  });

  // Fit full route on first draw
  if (completedUpTo === 0) {
    const allPts = [...doneCoords, ...leftCoords];
    if (allPts.length >= 2) {
      map.fitBounds(L.polyline(allPts).getBounds(), { padding: [50, 50] });
      userCentered = false;
      document.getElementById("recenter-btn").classList.add("show");
    }
  }
}

/* ------------------------------------------------------------------ */
/*  SPEAK                                                              */
/* ------------------------------------------------------------------ */

function speak(text, onEnd) {
  if (!window.speechSynthesis) { if (onEnd) onEnd(); return; }
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang  = "en-IN";
  utt.rate  = 0.93;
  utt.pitch = 1.0;
  if (onEnd) utt.onend = onEnd;
  window.speechSynthesis.speak(utt);
}

/* ------------------------------------------------------------------ */
/*  LISTEN                                                             */
/* ------------------------------------------------------------------ */

function listen() {
  return new Promise((resolve, reject) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { reject("not_supported"); return; }
    setVoiceStatus("listening");
    const rec = new SR();
    rec.lang = "en-IN"; rec.interimResults = false; rec.maxAlternatives = 3;
    rec.onresult = e => { setVoiceStatus("idle"); resolve(Array.from(e.results[0]).map(r => r.transcript.trim().toLowerCase())); };
    rec.onerror  = e => { setVoiceStatus("idle"); reject(e.error); };
    rec.onend    = ()  => setVoiceStatus("idle");
    rec.start();
  });
}

/* ------------------------------------------------------------------ */
/*  MATCH SPOKEN TEXT                                                  */
/* ------------------------------------------------------------------ */

function matchLocation(transcripts) {
  for (const transcript of transcripts) {
    const cleaned = transcript.toLowerCase().replace(/[^a-z0-9 ]/g, "");
    let best = null, bestScore = 0;
    for (const loc of allLocations) {
      const locName  = loc.name.toLowerCase().replace(/[^a-z0-9 ]/g, "");
      const locWords = locName.split(" ");
      const spoken   = cleaned.split(" ");
      const overlap  = locWords.filter(w => spoken.some(s => s.includes(w) || w.includes(s))).length;
      const score    = overlap / locWords.length;
      const contains = cleaned.includes(locName) || locName.includes(cleaned);
      const fs = contains ? 1 : score;
      if (fs > bestScore) { bestScore = fs; best = loc; }
    }
    if (bestScore >= 0.4) return best;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  HEADING                                                            */
/* ------------------------------------------------------------------ */

function computeHeading(lat1, lng1, lat2, lng2) {
  const r = d => d * Math.PI / 180;
  const dLng = r(lng2 - lng1);
  const x = Math.sin(dLng) * Math.cos(r(lat2));
  const y = Math.cos(r(lat1)) * Math.sin(r(lat2)) - Math.sin(r(lat1)) * Math.cos(r(lat2)) * Math.cos(dLng);
  return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
}

/* ------------------------------------------------------------------ */
/*  VOICE FLOW                                                         */
/* ------------------------------------------------------------------ */

async function runVoiceSetup() {
  setVoiceFlowVisible(true);
  const startMatched = await askVoiceLocation("start");
  const destMatched  = await askVoiceLocation("dest");
  if (startMatched && destMatched) {
    setVoicePrompt("✅ Both set. Starting navigation...");
    speak("Starting navigation now.", async () => { await delay(400); startNavigation(); });
  }
}

async function askVoiceLocation(which) {
  const isStart = which === "start";

  if (isStart) {
    const q = "Select your starting point. Shall I use your current location? Say yes to use GPS, or say the name of your starting location.";
    setVoicePrompt(q); speak(q); await delay(3800);
    try {
      const t = await listen();
      setVoicePrompt('Heard: "' + t[0] + '"');
      const isYes = t.some(x => x.includes("yes")||x.includes("yeah")||x.includes("sure")||x.includes("ok")||x.includes("current")||x.includes("my location")||x.includes("here")||x.includes("use my"));
      if (isYes) {
        setVoicePrompt("📡 Using your GPS location...");
        speak("Sure, using your current GPS location.");
        await useCurrentLocationAsync();
        checkStartReady(); return { fromGPS: true };
      }
      const direct = matchLocation(t);
      if (direct) {
        document.getElementById("start-select").value = direct.id;
        document.getElementById("start-select").classList.add("voice-set");
        setVoicePrompt("✅ Start: " + direct.name);
        speak("Got it. Starting location is " + direct.name + ".");
        checkStartReady(); await delay(2600); return direct;
      }
      setVoicePrompt("❓ Could not match. Asking again...");
      speak("Sorry, I could not find that. Let me ask again."); await delay(2500);
    } catch(e) {
      if (e === "not_supported") { speak("Voice not supported. Please use dropdowns."); return null; }
    }
  }

  const question = isStart ? "Please say your starting location clearly." : "Where do you want to go? Please say your destination.";
  let matched = null, attempts = 0;
  while (!matched && attempts < 3) {
    attempts++;
    setVoicePrompt(question); speak(question); await delay(3200);
    try {
      const t = await listen();
      setVoicePrompt('Heard: "' + t[0] + '" — matching...');
      matched = matchLocation(t);
      if (matched) {
        const selId = isStart ? "start-select" : "dest-select";
        document.getElementById(selId).value = matched.id;
        document.getElementById(selId).classList.add("voice-set");
        setVoicePrompt("✅ " + (isStart ? "Start" : "Destination") + ": " + matched.name);
        speak("Got it. " + (isStart ? "Starting location is " : "Destination is ") + matched.name + ".");
        checkStartReady(); await delay(2600);
      } else {
        const r = attempts < 3 ? "Sorry, try again." : "Please use the dropdown below.";
        setVoicePrompt("❓ Could not match. " + (attempts < 3 ? "Retrying..." : "Use dropdown."));
        speak(r); await delay(3000);
      }
    } catch(e) {
      if (e === "not_supported") { speak("Voice not supported."); return null; }
      return null;
    }
  }
  checkStartReady(); return matched;
}

/* ------------------------------------------------------------------ */
/*  GPS CURRENT LOCATION (async)                                      */
/* ------------------------------------------------------------------ */

function useCurrentLocation() { useCurrentLocationAsync(); }

function useCurrentLocationAsync() {
  return new Promise(resolve => {
    const btn = document.getElementById("gps-locate-btn");
    btn.disabled = true; btn.innerText = "📡 Locating...";
    setGpsStatus("waiting", "Getting your current position...");
    navigator.geolocation.getCurrentPosition(
      async pos => {
        try {
          const res  = await fetch("/nearest_location", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({lat:pos.coords.latitude,lng:pos.coords.longitude}) });
          const data = await res.json();
          if (data.error) { setGpsStatus("error",data.error); speak(data.error); btn.disabled=false; btn.innerText="📍 Use My Current Location"; resolve(null); return; }
          document.getElementById("start-select").value = data.location_id;
          document.getElementById("start-select").classList.add("voice-set");
          setVoicePrompt("📍 " + data.name + " (" + Math.round(data.distance_m) + "m away)");
          setGpsStatus("active","Location found: " + data.name);
          speak("Your current location is " + data.name + ".");
          btn.disabled=false; btn.innerText="✅ " + data.name;
          checkStartReady(); resolve(data);
        } catch(e) { setGpsStatus("error","Could not reach server."); btn.disabled=false; btn.innerText="📍 Use My Current Location"; resolve(null); }
      },
      () => { setGpsStatus("error","GPS denied."); speak("Could not get location. Allow GPS."); btn.disabled=false; btn.innerText="📍 Use My Current Location"; resolve(null); },
      { enableHighAccuracy:true, timeout:15000, maximumAge:0 }
    );
  });
}

/* ------------------------------------------------------------------ */
/*  UI HELPERS                                                         */
/* ------------------------------------------------------------------ */

const delay = ms => new Promise(r => setTimeout(r, ms));

function setVoiceStatus(state) {
  const btn = document.getElementById("voice-input-btn");
  const mic = document.getElementById("mic-icon");
  if (state === "listening") { btn.classList.add("listening"); mic.innerText = "🔴"; setVoicePrompt("Listening..."); }
  else { btn.classList.remove("listening"); mic.innerText = "🎙️"; }
}
function setVoicePrompt(msg) { const e = document.getElementById("voice-prompt"); if (e) e.innerText = msg; }
function setVoiceFlowVisible(show) { document.getElementById("voice-flow").style.display = show ? "block" : "none"; }
function toggleVoiceFlow() {
  const vf = document.getElementById("voice-flow");
  vf.style.display = vf.style.display === "block" ? "none" : "block";
  if (vf.style.display === "block") setVoicePrompt("Press the mic and speak your location.");
}
function setGpsStatus(state, msg) {
  document.getElementById("gps-dot").className = "gps-dot " + state;
  document.getElementById("gps-text").innerText = msg;
}
function checkStartReady() {
  const s = document.getElementById("start-select").value;
  const d = document.getElementById("dest-select").value;
  document.getElementById("start-btn").disabled = !(s && d && s !== d);
}

/* ------------------------------------------------------------------ */
/*  LOAD LOCATIONS                                                     */
/* ------------------------------------------------------------------ */

async function loadLocations() {
  try {
    const res = await fetch("/locations");
    const raw = await res.json();
    allLocations = raw.map(l => ({ id: l.id.trim().replace(/\r/g,""), name: l.name.trim().replace(/\r/g,"") }));
    const ss = document.getElementById("start-select");
    const ds = document.getElementById("dest-select");
    allLocations.forEach(l => { ss.appendChild(new Option(l.name, l.id)); ds.appendChild(new Option(l.name, l.id)); });
    [ss, ds].forEach(sel => sel.addEventListener("change", () => {
      checkStartReady();
      const s = ss.value, d = ds.value;
      if (s && d && s !== d) startNavigation();
    }));
  } catch(e) { setGpsStatus("error","Could not load campus data."); }
}

/* ------------------------------------------------------------------ */
/*  PAGE LOAD                                                          */
/* ------------------------------------------------------------------ */

window.onload = async function() {
  initMap();
  if (!navigator.geolocation) { setGpsStatus("error","Geolocation not supported."); return; }
  setGpsStatus("waiting","Ready.");
  await loadLocations();
  await delay(600);
  speak("Welcome to Campus Navigator. Use voice, GPS, or the dropdowns to begin.");
};

/* ------------------------------------------------------------------ */
/*  START NAVIGATION                                                   */
/* ------------------------------------------------------------------ */

async function startNavigation() {
  const start = document.getElementById("start-select").value.trim();
  const dest  = document.getElementById("dest-select").value.trim();
  destName    = document.getElementById("dest-select").selectedOptions[0].text.trim();
  if (!start || !dest || start === dest) return;
  document.getElementById("start-btn").disabled = true;
  setGpsStatus("waiting","Starting navigation...");

  try {
    const res  = await fetch("/start_navigation", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({start,destination:dest}) });
    const data = await res.json();
    if (data.error) { setGpsStatus("error","Error: "+data.error); speak("Error: "+data.error); document.getElementById("start-btn").disabled=false; return; }

    session_id   = data.session_id;
    totalSteps   = data.total_steps;
    currentStep  = 0;
    routeNodeIds = data.route;
    roadGeometry = data.road_geometry || [];
    lastLat = null; lastLng = null; userHeading = -1;
    lastInstruction = ""; lastSpokenStep = -1; lastSpokenDist = -1;
    spokenMilestones = new Set();

    // Draw full route on map
    drawRoute(routeNodeIds, 0);

    // Show nav UI, hide setup
    document.getElementById("setup-card").style.display        = "none";
    document.getElementById("instruction-banner").classList.add("show");
    document.getElementById("stop-wrap").style.display         = "block";
    document.getElementById("map").classList.add("nav-active");
    map.invalidateSize();

    updateProgress(0);
    speak("Navigation started. Heading to " + destName + ". Acquiring GPS signal.");
    setGpsStatus("waiting","Acquiring GPS signal...");

    watchId = navigator.geolocation.watchPosition(sendLocation, gpsError, { enableHighAccuracy:true, maximumAge:0, timeout:30000 });
    startCompass();  // start phone compass for accurate heading
  } catch(e) {
    setGpsStatus("error","Server connection failed."); speak("Could not connect to server.");
    document.getElementById("start-btn").disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/*  SEND GPS TO SERVER                                                 */
/* ------------------------------------------------------------------ */

async function sendLocation(position) {
  const lat = position.coords.latitude;
  const lng = position.coords.longitude;

  // Update heading from movement only if compass not available
  if (lastLat !== null && lastLng !== null) {
    const dist = Math.sqrt(Math.pow((lat-lastLat)*111000,2)+Math.pow((lng-lastLng)*111000*Math.cos(lat*Math.PI/180),2));
    if (dist > 3 && compassHeading < 0) userHeading = computeHeading(lastLat, lastLng, lat, lng);
  }
  lastLat = lat; lastLng = lng;

  // Update arrow on map
  updateArrowMarker(lat, lng, userHeading);
  setGpsStatus("active","GPS active · Tracking" + (userHeading>=0 ? " · "+Math.round(userHeading)+"°":""));

  try {
    const res  = await fetch("/update_location", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({session_id,lat,lng,heading:userHeading}) });
    const data = await res.json();
    if (data.error) { setGpsStatus("error","Session error."); return; }
    if (data.instruction === "Navigation complete.") { showArrived(); return; }

    const instruction = data.instruction;
    const distance    = Math.round(data.distance);
    const step        = data.step ?? currentStep;

    // Redraw route to update completed/remaining split
    if (step !== currentStep) {
      currentStep = step;
      drawRoute(routeNodeIds, step);
    }

    // Speak on step change only
    if (step !== lastSpokenStep) {
      speak(instruction);
      lastInstruction = instruction; lastSpokenStep = step;
      lastSpokenDist = distance; spokenMilestones = new Set();
    }

    // Speak at distance milestones (80, 50, 30, 15m) once per step
    for (const m of [80, 50, 30, 15]) {
      if (distance <= m && !spokenMilestones.has(m)) {
        spokenMilestones.add(m);
        if (Math.abs(distance - lastSpokenDist) > 3) {
          speak("In " + distance + " meters, " + instruction.toLowerCase());
          lastSpokenDist = distance;
        }
        break;
      }
    }

    // Update banner UI
    document.getElementById("instruction-text").innerText = instruction;
    document.getElementById("banner-distance").innerText  = distance + " m";
    document.getElementById("step-badge").innerText       = "STEP " + (step + 1);
    updateProgress(step);

  } catch(e) { setGpsStatus("error","Connection lost. Retrying..."); }
}

/* ------------------------------------------------------------------ */
/*  PROGRESS                                                           */
/* ------------------------------------------------------------------ */

function updateProgress(step) {
  const pct = totalSteps > 0 ? Math.round((step/totalSteps)*100) : 0;
  document.getElementById("progress-fill").style.width = pct + "%";
  document.getElementById("step-counter").innerText    = step + " / " + totalSteps;
}

/* ------------------------------------------------------------------ */
/*  ARRIVED                                                            */
/* ------------------------------------------------------------------ */

function showArrived() {
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }

  // Complete the route line visually
  drawRoute(routeNodeIds, routeNodeIds.length - 1);

  document.getElementById("instruction-banner").classList.remove("show");
  document.getElementById("stop-wrap").style.display  = "none";
  document.getElementById("arrived-card").style.display = "block";
  document.getElementById("arrived-box").style.display  = "block";
  document.getElementById("arrived-name").innerText   = "You have reached " + destName;
  document.getElementById("progress-fill").style.width = "100%";
  setGpsStatus("active","Arrived at destination.");
  speak("You have arrived at " + destName + ". Navigation complete.");
}

/* ------------------------------------------------------------------ */
/*  STOP NAVIGATION                                                    */
/* ------------------------------------------------------------------ */

function stopNavigation() {
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  session_id = null; lastInstruction = ""; userHeading = -1; compassHeading = -1; lastLat = null; lastLng = null;
  lastSpokenStep = -1; spokenMilestones = new Set(); routeNodeIds = [];

  // Clear map overlays
  if (routeRemaining) { map.removeLayer(routeRemaining); routeRemaining = null; }
  if (routeCompleted) { map.removeLayer(routeCompleted); routeCompleted = null; }
  if (arrowMarker)    { map.removeLayer(arrowMarker);    arrowMarker = null; }
  waypointMarkers.forEach(m => map.removeLayer(m)); waypointMarkers = [];

  // Reset all campus dots
  Object.entries(CAMPUS_NODES).forEach(([id, node]) => {
    const dot = L.divIcon({ className:"", html:`<div class="waypoint-dot" style="opacity:0.5"></div>`, iconSize:[12,12], iconAnchor:[6,6] });
    L.marker([node.lat, node.lng], {icon:dot}).bindPopup(`<b>${node.name}</b>`).addTo(map);
  });

  document.getElementById("map").classList.remove("nav-active");
  map.invalidateSize();
  document.getElementById("instruction-banner").classList.remove("show");
  document.getElementById("stop-wrap").style.display         = "none";
  document.getElementById("arrived-card").style.display      = "none";
  document.getElementById("setup-card").style.display        = "block";
  document.getElementById("start-btn").disabled              = true;
  document.getElementById("start-select").value              = "";
  document.getElementById("dest-select").value               = "";
  document.getElementById("start-select").classList.remove("voice-set");
  document.getElementById("dest-select").classList.remove("voice-set");
  document.getElementById("gps-locate-btn").innerText        = "📍 Use My Current Location";
  document.getElementById("gps-locate-btn").disabled         = false;
  setVoiceFlowVisible(false);
  setGpsStatus("waiting","Navigation stopped.");
  speak("Navigation stopped.");
  map.setView([12.3148, 76.6134], 17);
  document.getElementById("recenter-btn").classList.remove("show");
  userCentered = true;
}

/* ------------------------------------------------------------------ */
/*  GPS ERROR                                                          */
/* ------------------------------------------------------------------ */

function gpsError(error) {
  const msgs = {1:"Location permission denied. Allow it in settings.",2:"GPS unavailable. Move outdoors.",3:"GPS timed out. Move to open area."};
  const msg = msgs[error.code]||"Unknown GPS error.";
  setGpsStatus("error",msg); speak(msg);
}



/* ================================================================== */
/*  QR CODE SCANNER  — uses native BarcodeDetector (Android Chrome)   */
/*                     falls back to jsQR if not available            */
/* ================================================================== */

let qrStream     = null;
let qrAnimFrame  = null;
let qrActive     = false;
let qrDetector   = null;   // BarcodeDetector instance
let qrGuideIdx   = 0;
let qrLastGuide  = 0;
let qrScanCount  = 0;      // debug: how many frames scanned

const QR_GUIDES = [
  "Move the phone closer to the QR code.",
  "Move the phone to the left.",
  "Move the phone to the right.",
  "Move the phone up.",
  "Move the phone down.",
  "Try tilting the camera slightly.",
  "Move the phone back a little.",
  "Make sure the QR code is well lit.",
];

/* ── OPEN ─────────────────────────────────────────────────────────── */
async function openQRScanner() {
  const overlay = document.getElementById("qr-overlay");
  overlay.classList.add("show");
  qrActive    = true;
  qrGuideIdx  = 0;
  qrLastGuide = Date.now();
  qrScanCount = 0;

  // Check what scanner is available
  let method = "none";
  if (typeof BarcodeDetector !== "undefined") {
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (formats.includes("qr_code")) {
        qrDetector = new BarcodeDetector({ formats: ["qr_code"] });
        method = "BarcodeDetector";
      }
    } catch(e) {}
  }
  if (method === "none" && typeof jsQR !== "undefined") {
    method = "jsQR";
  }

  setQRStatus("📷 Starting camera...", "Method: " + method);

  if (method === "none") {
    setQRStatus("❌ No QR scanner available", "Please use Chrome on Android");
    speak("QR scanning is not supported on this browser. Please use Chrome.");
    return;
  }

  // Start camera
  try {
    qrStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }
    });
  } catch(e) {
    try {
      qrStream = await navigator.mediaDevices.getUserMedia({ video: true });
    } catch(e2) {
      setQRStatus("❌ Camera denied", "Allow camera in browser settings");
      speak("Camera access denied. Please allow camera and try again.");
      return;
    }
  }

  const video = document.getElementById("qr-video");
  video.srcObject = qrStream;
  video.setAttribute("playsinline", true);
  await video.play().catch(()=>{});

  document.getElementById("qr-indicator-bar").style.width = "0%";
  setQRStatus("📷 Scanning for QR code...", "Point at any QR code");
  speak("Camera ready. Point your camera at the QR code on the department entrance.");

  if (method === "BarcodeDetector") {
    qrLoopDetector();
  } else {
    qrAnimFrame = requestAnimationFrame(qrLoopJsQR);
  }
}

/* ── METHOD 1: Native BarcodeDetector ──────────────────────────────── */
async function qrLoopDetector() {
  if (!qrActive) return;
  const video = document.getElementById("qr-video");

  try {
    const barcodes = await qrDetector.detect(video);
    qrScanCount++;
    document.getElementById("qr-hint").innerText = "Frames scanned: " + qrScanCount;

    if (barcodes.length > 0) {
      qrHandleResult(barcodes[0].rawValue, null, video);
      return;
    }
  } catch(e) {}

  // Voice guidance every 5s
  const now = Date.now();
  if (now - qrLastGuide > 5000) {
    qrLastGuide = now;
    const msg = QR_GUIDES[qrGuideIdx % QR_GUIDES.length];
    qrGuideIdx++;
    setQRStatus("📷 Scanning...", msg + "  (frames: " + qrScanCount + ")");
    speakOnceQR(msg);
  }

  setTimeout(qrLoopDetector, 200);  // scan 5x per second
}

/* ── METHOD 2: jsQR fallback ─────────────────────────────────────── */
function qrLoopJsQR(ts) {
  if (!qrActive) return;
  const video  = document.getElementById("qr-video");
  const canvas = document.getElementById("qr-canvas");

  if (video.videoWidth && video.videoHeight) {
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0);
    qrScanCount++;
    document.getElementById("qr-hint").innerText = "Frames: " + qrScanCount + " | " + canvas.width + "x" + canvas.height;

    try {
      const img  = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" });
      if (code && code.data) {
        qrHandleResult(code.data, code.location, video);
        return;
      }
    } catch(e) {
      setQRStatus("jsQR error: " + e.message, "");
    }
  }

  // Voice guidance every 5s
  const now = Date.now();
  if (now - qrLastGuide > 5000) {
    qrLastGuide = now;
    const msg = QR_GUIDES[qrGuideIdx % QR_GUIDES.length];
    qrGuideIdx++;
    setQRStatus("📷 Scanning...", msg);
    speakOnceQR(msg);
  }

  qrAnimFrame = requestAnimationFrame(qrLoopJsQR);
}

/* ── HANDLE RESULT ───────────────────────────────────────────────── */
async function qrHandleResult(data, location, video) {
  qrActive = false;
  if (qrAnimFrame) { cancelAnimationFrame(qrAnimFrame); qrAnimFrame = null; }

  document.getElementById("qr-indicator-bar").style.width = "100%";
  setQRStatus("✅ Scanned: " + data, "");
  speak("QR code scanned. " + data);

  await new Promise(r => setTimeout(r, 600));
  closeQRScanner();
  await matchQRToLocation(data.trim());
}

/* ── CLOSE ───────────────────────────────────────────────────────── */
function closeQRScanner() {
  qrActive = false;
  if (qrAnimFrame) { cancelAnimationFrame(qrAnimFrame); qrAnimFrame = null; }
  if (qrStream)    { qrStream.getTracks().forEach(t => t.stop()); qrStream = null; }
  document.getElementById("qr-overlay").classList.remove("show");
  document.getElementById("qr-indicator-bar").style.width = "0%";
}

/* ── MATCH TO LOCATION ───────────────────────────────────────────── */
async function matchQRToLocation(data) {
  try {
    const res  = await fetch("/locations");
    const locs = await res.json();
    const low  = data.toLowerCase();
    let matched = null;

    for (const loc of locs) {
      if (loc.id === data || loc.name.toLowerCase() === low ||
          loc.name.toLowerCase().includes(low)) {
        matched = loc; break;
      }
    }

    if (matched) {
      speak("You are at " + matched.name + ". Setting as your starting location.");
      const sel = document.getElementById("start-select");
      sel.value = matched.id;
      sel.classList.add("voice-set");
      document.getElementById("start-btn").disabled = !document.getElementById("dest-select").value;
      setGpsStatus("active", "📷 Location: " + matched.name);
      await new Promise(r => setTimeout(r, 2800));
      speak("Where would you like to go? Select a destination or tap the mic.");
    } else {
      speak("QR code read as: " + data + ". Location not found in campus map.");
      setGpsStatus("error", "Not found: " + data);
    }
  } catch(e) {
    speak("Could not connect to server. Please try again.");
  }
}

/* ── HELPERS ─────────────────────────────────────────────────────── */
function setQRStatus(status, hint) {
  const s = document.getElementById("qr-status");
  const h = document.getElementById("qr-hint");
  if (s) s.innerText = status;
  if (h) h.innerText = hint !== undefined ? hint : "";
}

let _lastQRSpoken = "";
function speakOnceQR(msg) {
  if (msg === _lastQRSpoken) return;
  _lastQRSpoken = msg;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(msg);
  u.rate = 0.92; u.pitch = 1; u.volume = 1;
  u.onend = () => { _lastQRSpoken = ""; };
  window.speechSynthesis.speak(u);
}
