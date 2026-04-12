/* ============================================================
   Campus Navigator — script.js
   Ultimate Merged Version: Smoothed Compass + Smart Speech + Rerouting
   ============================================================ */

/* ------------------------------------------------------------------ */
/* CAMPUS NODE COORDINATES                                           */
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
/* STATE & COMPASS (Circular Mean Averaging)                         */
/* ------------------------------------------------------------------ */

let session_id = null, watchId = null, totalSteps = 0, currentStep = 0;
let destName = "", allLocations = [];
let lastLat = null, lastLng = null, userHeading = -1, compassHeading = -1;

// Tracking for smart speech
let lastSpokenInstruction = "", lastSpokenAnnounceType = "";
let lastSpokenDist = -1, lastStepSpoken = -1;
let preWarnSpoken = new Set(), continueSpokenAt = -1;

function startCompass() {
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission().then(state => {
      if (state === 'granted') listenOrientation();
    }).catch(() => {});
  } else listenOrientation();
}

function listenOrientation() {
  window.addEventListener('deviceorientationabsolute', handleOrientation, true);
  window.addEventListener('deviceorientation', handleOrientation, true);
}

let _compassHistory = [];
function handleOrientation(e) {
  let heading = null;
  if (e.webkitCompassHeading !== undefined && e.webkitCompassHeading !== null) { heading = e.webkitCompassHeading; } 
  else if (e.absolute && e.alpha !== null) { heading = (360 - e.alpha) % 360; } 
  else if (!e.absolute && e.alpha !== null) { heading = (360 - e.alpha) % 360; }
  
  if (heading !== null && !isNaN(heading)) {
    _compassHistory.push(heading);
    if (_compassHistory.length > 5) _compassHistory.shift();
    let sinSum = 0, cosSum = 0;
    for (const h of _compassHistory) {
      sinSum += Math.sin(h * Math.PI / 180); cosSum += Math.cos(h * Math.PI / 180);
    }
    const smoothed = (Math.atan2(sinSum, cosSum) * 180 / Math.PI + 360) % 360;
    compassHeading = smoothed; userHeading = smoothed;
  }
}

// Full route variables
let routeNodeIds = [], roadGeometry = [];

/* ------------------------------------------------------------------ */
/* MAP SETUP                                                         */
/* ------------------------------------------------------------------ */

let map, streetLayer, satelliteLayer, isSatellite = false;
let arrowMarker = null, routeRemaining = null, routeCompleted = null, waypointMarkers = [];
let userCentered = true;

function initMap() {
  map = L.map("map", { center: [12.3148, 76.6137], zoom: 17, zoomControl: true, attributionControl: false });
  streetLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 20 }).addTo(map);
  satelliteLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 20 });

  Object.entries(CAMPUS_NODES).forEach(([id, node]) => {
    const dot = L.divIcon({ className: "", html: `<div class="waypoint-dot" style="opacity:0.5"></div>`, iconSize: [12, 12], iconAnchor: [6, 6] });
    L.marker([node.lat, node.lng], { icon: dot }).bindPopup(`<b>${node.name}</b>`).addTo(map);
  });

  map.on("dragstart", () => {
    userCentered = false;
    document.getElementById("recenter-btn").classList.add("show");
  });
}

function toggleMapLayer() {
  const btn = document.getElementById("map-toggle");
  if (isSatellite) { map.removeLayer(satelliteLayer); streetLayer.addTo(map); btn.textContent = "🛰 SATELLITE"; isSatellite = false; } 
  else { map.removeLayer(streetLayer); satelliteLayer.addTo(map); btn.textContent = "🗺 STREET"; isSatellite = true; }
}

function recenterMap() {
  if (lastLat !== null) { map.setView([lastLat, lastLng], 18); userCentered = true; document.getElementById("recenter-btn").classList.remove("show"); }
}

function createArrowIcon(heading) {
  const h = heading >= 0 ? heading : 0;
  return L.divIcon({
    className: "", iconSize: [36, 36], iconAnchor: [18, 18],
    html: `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
             <circle cx="18" cy="18" r="14" fill="#00d4ff" fill-opacity="0.25" stroke="#00d4ff" stroke-width="1.5"/>
             <circle cx="18" cy="18" r="7"  fill="#00d4ff"/>
             <polygon points="18,4 22,16 18,13 14,16" fill="white" transform="rotate(${h}, 18, 18)"/>
           </svg>`
  });
}

function updateArrowMarker(lat, lng, heading) {
  const icon = createArrowIcon(heading);
  if (!arrowMarker) { arrowMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 }).addTo(map); } 
  else { arrowMarker.setLatLng([lat, lng]); arrowMarker.setIcon(icon); }
  if (userCentered) map.setView([lat, lng], map.getZoom());
}

function drawRoute(nodeIds, completedUpTo) {
  if (routeRemaining) { map.removeLayer(routeRemaining); routeRemaining = null; }
  if (routeCompleted) { map.removeLayer(routeCompleted); routeCompleted = null; }
  waypointMarkers.forEach(m => map.removeLayer(m)); waypointMarkers = [];
  if (nodeIds.length < 2) return;

  function getSegmentCoords(stepIdx) {
    const wps = roadGeometry[stepIdx];
    if (wps && wps.length >= 2) return wps;
    const a = CAMPUS_NODES[nodeIds[stepIdx]], b = CAMPUS_NODES[nodeIds[stepIdx + 1]];
    return a && b ? [[a.lat, a.lng], [b.lat, b.lng]] : [];
  }

  const doneCoords = [], leftCoords = [];
  for (let i = 0; i < nodeIds.length - 1; i++) {
    const seg = getSegmentCoords(i);
    if (i < completedUpTo) doneCoords.push(...seg);
    else {
      if (leftCoords.length === 0 && doneCoords.length > 0) leftCoords.push(doneCoords[doneCoords.length - 1]);
      leftCoords.push(...seg);
    }
  }

  if (doneCoords.length >= 2) routeCompleted = L.polyline(doneCoords, { color: "#4a5568", weight: 4, opacity: 0.7, dashArray: "6 6" }).addTo(map);
  if (leftCoords.length >= 2) routeRemaining = L.polyline(leftCoords, { color: "#00d4ff", weight: 6, opacity: 0.95 }).addTo(map);

  nodeIds.forEach((id, idx) => {
    const n = CAMPUS_NODES[id];
    if (!n) return;
    const isDest = idx === nodeIds.length - 1;
    let cls = "waypoint-dot" + (idx < completedUpTo ? " done" : "") + (isDest ? " dest" : "");
    const dotIcon = L.divIcon({ className: "", html: `<div class="${cls}"></div>`, iconSize: isDest ? [16,16] : [12,12], iconAnchor: isDest ? [8,8] : [6,6] });
    const m = L.marker([n.lat, n.lng], { icon: dotIcon }).bindPopup(`<b>${n.name}</b>`).addTo(map);
    waypointMarkers.push(m);
  });

  if (completedUpTo === 0 && [...doneCoords, ...leftCoords].length >= 2) {
    map.fitBounds(L.polyline([...doneCoords, ...leftCoords]).getBounds(), { padding: [50, 50] });
    userCentered = false; document.getElementById("recenter-btn").classList.add("show");
  }
}

/* ------------------------------------------------------------------ */
/* UTILITIES (Speak, Listen, Heading)                                */
/* ------------------------------------------------------------------ */

function speak(text, onEnd) {
  if (!window.speechSynthesis) { if (onEnd) onEnd(); return; }
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text); utt.lang = "en-IN"; utt.rate = 0.93;
  if (onEnd) utt.onend = onEnd; window.speechSynthesis.speak(utt);
}

function listen() {
  return new Promise((resolve, reject) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { reject("not_supported"); return; }
    setVoiceStatus("listening");
    const rec = new SR(); rec.lang = "en-IN"; rec.maxAlternatives = 3;
    rec.onresult = e => { setVoiceStatus("idle"); resolve(Array.from(e.results[0]).map(r => r.transcript.trim().toLowerCase())); };
    rec.onerror  = e => { setVoiceStatus("idle"); reject(e.error); };
    rec.onend    = ()  => setVoiceStatus("idle");
    rec.start();
  });
}

function computeHeading(lat1, lng1, lat2, lng2) {
  const r = d => d * Math.PI / 180;
  const dLng = r(lng2 - lng1);
  const x = Math.sin(dLng) * Math.cos(r(lat2));
  const y = Math.cos(r(lat1)) * Math.sin(r(lat2)) - Math.sin(r(lat1)) * Math.cos(r(lat2)) * Math.cos(dLng);
  return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
}

const delay = ms => new Promise(r => setTimeout(r, ms));
function setVoiceStatus(state) {
  const btn = document.getElementById("voice-input-btn"), mic = document.getElementById("mic-icon");
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
function setGpsStatus(state, msg) { document.getElementById("gps-dot").className = "gps-dot " + state; document.getElementById("gps-text").innerHTML = msg; }
function checkStartReady() { const s = document.getElementById("start-select").value, d = document.getElementById("dest-select").value; document.getElementById("start-btn").disabled = !(s && d && s !== d); }

/* ------------------------------------------------------------------ */
/* INITIALIZATION & START ROUTINE                                    */
/* ------------------------------------------------------------------ */

async function loadLocations() {
  try {
    const res = await fetch("/locations"), raw = await res.json();
    allLocations = raw.map(l => ({ id: l.id.trim().replace(/\r/g,""), name: l.name.trim().replace(/\r/g,"") }));
    const ss = document.getElementById("start-select"), ds = document.getElementById("dest-select");
    allLocations.forEach(l => { ss.appendChild(new Option(l.name, l.id)); ds.appendChild(new Option(l.name, l.id)); });
    [ss, ds].forEach(sel => sel.addEventListener("change", () => { checkStartReady(); if (ss.value && ds.value && ss.value !== ds.value) startNavigation(); }));
  } catch(e) { setGpsStatus("error","Could not load campus data."); }
}

window.onload = async function() {
  initMap();
  if (!navigator.geolocation) { setGpsStatus("error","Geolocation not supported."); return; }
  setGpsStatus("waiting","Ready.");
  await loadLocations();
  await delay(600); speak("Welcome to Campus Navigator. Use voice, GPS, or the dropdowns to begin.");
};

function useCurrentLocation() {
  const btn = document.getElementById("gps-locate-btn"); btn.disabled = true; btn.innerText = "📡 Locating...";
  navigator.geolocation.getCurrentPosition(async pos => {
      try {
        const res = await fetch("/nearest_location", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({lat:pos.coords.latitude,lng:pos.coords.longitude}) });
        const data = await res.json();
        if (data.error) { setGpsStatus("error",data.error); btn.innerText="📍 Use My Current Location"; btn.disabled=false; return; }
        document.getElementById("start-select").value = data.location_id; checkStartReady();
        btn.innerText="✅ " + data.name; btn.disabled=false; setGpsStatus("active","Location found.");
      } catch(e) { btn.disabled=false; btn.innerText="📍 Try Again"; }
    }, () => { btn.disabled=false; btn.innerText="📍 Use My Current Location"; }, { enableHighAccuracy:true });
}

async function startNavigation() {
  const start = document.getElementById("start-select").value.trim(), dest = document.getElementById("dest-select").value.trim();
  destName = document.getElementById("dest-select").selectedOptions[0].text.trim();
  if (!start || !dest || start === dest) return;
  document.getElementById("start-btn").disabled = true; setGpsStatus("waiting","Starting...");

  try {
    const res = await fetch("/start_navigation", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({start,destination:dest}) });
    const data = await res.json();
    if (data.error) { speak("Error: "+data.error); document.getElementById("start-btn").disabled=false; return; }

    session_id = data.session_id; totalSteps = data.total_steps; currentStep = 0; routeNodeIds = data.route; roadGeometry = data.road_geometry || [];
    lastLat = null; lastLng = null; userHeading = -1; lastSpokenInstruction = ""; lastSpokenAnnounceType = ""; preWarnSpoken = new Set(); continueSpokenAt = -1;

    drawRoute(routeNodeIds, 0);
    document.getElementById("setup-card").style.display = "none";
    document.getElementById("instruction-banner").classList.add("show");
    document.getElementById("stop-wrap").style.display = "block";
    document.getElementById("map").classList.add("nav-active"); map.invalidateSize();

    updateProgress(0); speak("Navigation started. Heading to " + destName);
    startCompass();

    // Raw GPS auto-start check
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const gpsRes = await fetch("/start_navigation", {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({lat:pos.coords.latitude, lng:pos.coords.longitude, destination:dest})
        });
        const gpsData = await gpsRes.json();
        if (gpsData.session_id) {
          session_id = gpsData.session_id; routeNodeIds = gpsData.route; roadGeometry = gpsData.road_geometry; drawRoute(routeNodeIds, 0);
        }
      } catch(e) {}
      watchId = navigator.geolocation.watchPosition(sendLocation, gpsError, { enableHighAccuracy:true, maximumAge:0, timeout:15000 });
    }, () => {
      watchId = navigator.geolocation.watchPosition(sendLocation, gpsError, { enableHighAccuracy:true, maximumAge:0, timeout:15000 });
    }, { enableHighAccuracy:true, timeout:10000 });

  } catch(e) { document.getElementById("start-btn").disabled = false; }
}

/* ------------------------------------------------------------------ */
/* GPS TRACKING & SMART SPEECH (MERGED LOGIC)                        */
/* ------------------------------------------------------------------ */

async function sendLocation(position) {
  const lat = position.coords.latitude, lng = position.coords.longitude, acc = Math.round(position.coords.accuracy || 999);
  
  if (lastLat !== null && lastLng !== null) {
    const moveDist = Math.sqrt(Math.pow((lat-lastLat)*111000,2) + Math.pow((lng-lastLng)*111000*Math.cos(lat*Math.PI/180),2));
    if (moveDist > 2.5 && compassHeading < 0) userHeading = computeHeading(lastLat, lastLng, lat, lng);
  }
  lastLat = lat; lastLng = lng; updateArrowMarker(lat, lng, userHeading);

  setGpsStatus("active", `Tracking · ${userHeading >= 0 ? Math.round(userHeading) + "°" : "no heading"} · GPS: ±${acc}m`);

  try {
    const res = await fetch("/update_location", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({session_id, lat, lng, heading: userHeading, accuracy: acc})
    });
    const data = await res.json();
    if (data.error) return;
    if (data.instruction === "Navigation complete." || data.arrived) { showArrived(); return; }

    const { instruction, distance, step = currentStep, announce_type: announceType = "continue", off_route: offRoute } = data;

    if (step !== currentStep) { currentStep = step; drawRoute(routeNodeIds, step); }
    updateBearingOverlay(data.target_bearing, userHeading);

    // ── REROUTING LOGIC (With Cooldown) ──
    if (offRoute) {
      const now = Date.now();
      if (!window._lastOffRouteSpeak || now - window._lastOffRouteSpeak > 8000) {
        window._lastOffRouteSpeak = now;
        speak(instruction);
      }
      document.getElementById("instruction-text").innerText = "⚠️ " + instruction;
      document.getElementById("banner-distance").innerText  = Math.round(distance) + " m to path";
      document.getElementById("step-badge").innerText       = "OFF ROUTE";
      return;
    }
    window._lastOffRouteSpeak = 0;

    // ── GOOGLE MAPS-STYLE SPEECH LOGIC ──
    const instrKey = announceType + "|" + instruction;
    
    if (announceType === "current" && instrKey !== lastSpokenInstruction) {
      speak(instruction); lastSpokenInstruction = instrKey; lastSpokenAnnounceType = announceType; preWarnSpoken = new Set(); continueSpokenAt = -1;
    } else if (announceType === "upcoming") {
      if (distance <= 65 && distance > 30 && !preWarnSpoken.has(instrKey+"|60")) {
        preWarnSpoken.add(instrKey+"|60"); speak(instruction); lastSpokenInstruction = instrKey;
      } else if (distance <= 25 && !preWarnSpoken.has(instrKey+"|20")) {
        preWarnSpoken.add(instrKey+"|20"); speak(instruction); lastSpokenInstruction = instrKey;
      }
    } else {
      if (step !== lastStepSpoken) {
        lastStepSpoken = step; continueSpokenAt = distance; speak(instruction); lastSpokenInstruction = instrKey;
      } else if (continueSpokenAt > 0 && continueSpokenAt - distance >= 100) {
        continueSpokenAt = distance; speak(instruction); lastSpokenInstruction = instrKey;
      }
    }

    // Update UI
    document.getElementById("instruction-text").innerText = instruction;
    document.getElementById("banner-distance").innerText  = Math.round(distance) + " m";
    document.getElementById("step-badge").innerText       = "STEP " + (step + 1);
    updateProgress(step);

  } catch(e) {}
}

function updateBearingOverlay(targetBear, userHead) {
  let el = document.getElementById("bearing-overlay");
  if (!el) {
    el = document.createElement("div"); el.id = "bearing-overlay";
    el.style.cssText = `position:fixed; bottom:160px; right:14px; width:48px; height:48px; background:rgba(13,25,41,0.88); border:2px solid #00d4ff; border-radius:50%; display:flex; align-items:center; justify-content:center; z-index:2000; font-size:22px; transition:transform 0.3s; box-shadow:0 2px 12px rgba(0,212,255,0.25);`;
    document.body.appendChild(el);
  }
  if (targetBear >= 0 && userHead >= 0) {
    el.style.transform = `rotate(${(targetBear - userHead + 360) % 360}deg)`;
    el.innerHTML = "↑"; el.style.color = "#00d4ff";
  } else if (targetBear >= 0) { el.innerHTML = "↑"; el.style.color = "#ffb800"; el.style.transform = "none"; }
}

function showArrived() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  drawRoute(routeNodeIds, routeNodeIds.length - 1);
  document.getElementById("instruction-banner").classList.remove("show");
  document.getElementById("stop-wrap").style.display = "none";
  document.getElementById("arrived-card").style.display = "block";
  document.getElementById("arrived-name").innerText = "You have reached " + destName;
  setGpsStatus("active","Arrived."); speak("You have arrived at " + destName + ".");
}

function stopNavigation() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  session_id = null; watchId = null; routeNodeIds = [];
  const bo = document.getElementById("bearing-overlay"); if (bo) bo.remove();
  if (routeRemaining) map.removeLayer(routeRemaining); if (routeCompleted) map.removeLayer(routeCompleted);
  if (arrowMarker) map.removeLayer(arrowMarker); waypointMarkers.forEach(m => map.removeLayer(m));
  
  Object.entries(CAMPUS_NODES).forEach(([id, node]) => {
    L.marker([node.lat, node.lng], {icon: L.divIcon({ className:"", html:`<div class="waypoint-dot" style="opacity:0.5"></div>`, iconSize:[12,12], iconAnchor:[6,6] })}).bindPopup(`<b>${node.name}</b>`).addTo(map);
  });

  document.getElementById("map").classList.remove("nav-active"); map.invalidateSize();
  document.getElementById("instruction-banner").classList.remove("show");
  document.getElementById("stop-wrap").style.display = "none";
  document.getElementById("arrived-card").style.display = "none";
  document.getElementById("setup-card").style.display = "block";
  setGpsStatus("waiting","Navigation stopped."); speak("Navigation stopped.");
  map.setView([12.3148, 76.6134], 17); userCentered = true;
}

function gpsError() { setGpsStatus("error","GPS error."); speak("GPS error."); }

/* ------------------------------------------------------------------ */
/* INDOOR NAVIGATION (WITH UI STAIRS WARNING)                        */
/* ------------------------------------------------------------------ */
let indoorStart = null, indoorSteps = [], indoorStepIdx = 0;

async function startIndoorNavigation(locationId) {
  let locName = locationId;
  try { const r = await fetch("/indoor/locations"); const locs = await r.json(); locName = locs[locationId]?.name || locationId; } catch(e) {}
  indoorStart = locationId; speak("You are at " + locName + ". Select destination.");

  let dests = [];
  try {
    const r = await fetch("/indoor/navigate", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({start: locationId}) });
    dests = (await r.json()).destinations || [];
  } catch(e) {}

  if (!dests.length) { speak("No indoor routes available."); return; }

  renderIndoorPanel(`
    <div style="font-size:15px;font-weight:700;margin-bottom:14px;">📍 ${locName}</div>
    <div style="display:flex;flex-direction:column;gap:8px;max-height:280px;overflow-y:auto;">
      ${dests.map(d => `<button class="ind-btn" onclick="selectIndoorDest('${d.id}','${d.name.replace(/'/g,"\\'")}')">🚪 ${d.name}</button>`).join("")}
    </div>
    <button class="ind-cancel" onclick="closeIndoorPanel()">✕ Cancel</button>
  `);
}

async function selectIndoorDest(destId, destName) {
  speak("Getting directions to " + destName);
  try {
    const res = await fetch("/indoor/route", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({start: indoorStart, destination: destId}) });
    const data = await res.json();
    if (data.found) {
      indoorSteps = data.steps; indoorStepIdx = 0;
      // Show Visual UX Warning if stairs are involved
      if (destId.includes("stairs") || destName.toLowerCase().includes("stair")) { showStairsWarning(destId, destName); } 
      else { renderCurrentStep(destName); }
    } else speak("No route found.");
  } catch(e) {}
}

function showStairsWarning(destId, destName) {
  renderIndoorPanel(`
    <div style="text-align:center;padding:8px 0 16px;">
      <div style="font-size:40px;margin-bottom:8px;">⚠️</div>
      <div style="font-size:17px;font-weight:700;color:#ffb800;margin-bottom:8px;">Staircase Ahead</div>
      <div style="font-size:13px;color:#7a8dab;margin-bottom:20px;">This route uses stairs. We recommend taking the lift.</div>
      <button class="ind-btn" style="background:linear-gradient(135deg,#00d4ff20,#00d4ff40); border-color:#00d4ff;color:#00d4ff;" onclick="rerouteViaLift('${destId}','${destName.replace(/'/g,"\\'")}')">🛗 Use Lift Instead</button>
      <button class="ind-btn" style="margin-top:10px;color:#ffb800;border-color:#ffb800;" onclick="proceedWithStairs('${destName.replace(/'/g,"\\'")}')">🚶 Proceed with Stairs</button>
    </div>
  `);
  speak("Warning. This route uses a staircase. Would you like to use the lift instead?");
}

async function rerouteViaLift(destId, destName) {
  speak("Rerouting via lift.");
  try {
    const res = await fetch("/indoor/route", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({start: indoorStart, destination: destId, use_lift: true}) });
    const data = await res.json();
    if (data.found) { indoorSteps = data.steps; indoorStepIdx = 0; renderCurrentStep(destName); } 
    else { speak("No lift route. Showing original."); renderCurrentStep(destName); }
  } catch(e) { renderCurrentStep(destName); }
}

function proceedWithStairs(destName) { speak("Proceeding with stairs."); renderCurrentStep(destName); }

function renderCurrentStep(destName) {
  if (indoorStepIdx >= indoorSteps.length) { speak("Arrived at destination."); setTimeout(closeIndoorPanel, 3000); return; }
  const step = indoorSteps[indoorStepIdx], prog = indoorStepIdx + 1, total = indoorSteps.length;

  renderIndoorPanel(`
    <div style="font-size:12px;color:#7a8dab;margin-bottom:6px;">Step ${prog} of ${total}</div>
    <div style="background:#1a2235;border-left:3px solid #00d4ff;padding:14px;border-radius:8px;font-size:16px;margin-bottom:16px;">${step}</div>
    <div style="display:flex;gap:8px;margin-bottom:8px;">
      ${prog > 1 ? `<button class="ind-btn" style="flex:1" onclick="indoorStepIdx--; renderCurrentStep();">← Back</button>` : ""}
      <button class="ind-btn" style="flex:2;background:linear-gradient(135deg,#00d4ff20,#00d4ff40);border-color:#00d4ff;color:#00d4ff;" onclick="indoorStepIdx++; renderCurrentStep();">${prog < total ? "Next →" : "✅ Arrived"}</button>
    </div>
    <button onclick="speak('${step.replace(/'/g,"\\'")}')" class="ind-btn" style="margin-bottom:6px;">🔊 Repeat</button>
    <button class="ind-cancel" onclick="closeIndoorPanel()">✕ Stop</button>
  `);
  speak(step);
}

function renderIndoorPanel(html) {
  let p = document.getElementById("indoor-panel");
  if (!p) { p = document.createElement("div"); p.id = "indoor-panel"; document.body.appendChild(p); }
  p.style.cssText = `position:fixed;bottom:0;left:0;right:0;max-width:480px;margin:0 auto; background:#131929;border-top:2px solid #00d4ff;border-radius:20px 20px 0 0; padding:20px;z-index:4000;color:#e8f0fe;`;
  if (!document.getElementById("ind-styles")) {
    const s = document.createElement("style"); s.id = "ind-styles";
    s.textContent = `.ind-btn{background:#1a2235;border:1px solid #2a3a55;color:#e8f0fe;padding:12px 16px;border-radius:12px;cursor:pointer;width:100%;} .ind-cancel{margin-top:8px;width:100%;padding:10px;background:transparent;border:1px solid #ff4d6d;color:#ff4d6d;border-radius:12px;cursor:pointer;}`;
    document.head.appendChild(s);
  }
  p.innerHTML = html; p.style.display = "block";
}
function closeIndoorPanel() { const p = document.getElementById("indoor-panel"); if (p) p.style.display = "none"; indoorSteps=[]; indoorStepIdx=0; }
