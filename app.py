from flask import Flask, request, jsonify, send_from_directory
import json
import networkx as nx
import uuid
import time
import threading
from math import radians, sin, cos, sqrt, atan2, degrees
import os

app = Flask(__name__)

# ─────────────────────────────────────────────
# Math Helpers
# ─────────────────────────────────────────────

def haversine(lat1, lon1, lat2, lon2):
    R = 6371000
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat/2)**2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon/2)**2
    return R * 2 * atan2(sqrt(a), sqrt(1 - a))

def bearing(lat1, lon1, lat2, lon2):
    lat1, lat2 = radians(lat1), radians(lat2)
    dlon = radians(lon2 - lon1)
    x = sin(dlon) * cos(lat2)
    y = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dlon)
    return (degrees(atan2(x, y)) + 360) % 360

# ─────────────────────────────────────────────
# Off-Route Detection
# ─────────────────────────────────────────────

def point_to_segment_dist(plat, plng, alat, alng, blat, blng):
    """Perpendicular distance in metres from point P to segment AB."""
    # Convert to approximate metres
    scale_lat = 111320.0
    scale_lng = 111320.0 * cos(radians((alat + blat) / 2))
    px = (plng - alng) * scale_lng
    py = (plat - alat) * scale_lat
    bx = (blng - alng) * scale_lng
    by = (blat - alat) * scale_lat
    seg_len2 = bx*bx + by*by
    if seg_len2 < 1e-10:
        return sqrt(px*px + py*py)
    t = max(0.0, min(1.0, (px*bx + py*by) / seg_len2))
    dx = px - t*bx
    dy = py - t*by
    return sqrt(dx*dx + dy*dy)

def dist_to_route(slat, slng, flat_wps, wp_idx):
    """Minimum perpendicular distance from position to remaining route segments."""
    best = float("inf")
    wps = flat_wps
    # Check current segment and a few ahead
    for i in range(max(0, wp_idx - 1), min(wp_idx + 5, len(wps) - 1)):
        d = point_to_segment_dist(
            slat, slng,
            wps[i]["lat"], wps[i]["lng"],
            wps[i+1]["lat"], wps[i+1]["lng"]
        )
        if d < best:
            best = d
    return best

# ─────────────────────────────────────────────
# Load Campus Map
# ─────────────────────────────────────────────

_BASE = os.path.dirname(os.path.abspath(__file__))

with open(os.path.join(_BASE, "campus.json"), "r") as f:
    campus_data = json.load(f)

# Build directed weighted graph
G = nx.DiGraph()
graph_nodes = set()

for start, dests in campus_data["paths"].items():
    s = start.strip()
    for end, waypoints in dests.items():
        e = end.strip()
        sloc = campus_data["locations"].get(s, {})
        eloc = campus_data["locations"].get(e, {})
        if waypoints and len(waypoints) >= 2:
            dist = sum(
                haversine(waypoints[i][0], waypoints[i][1],
                          waypoints[i+1][0], waypoints[i+1][1])
                for i in range(len(waypoints) - 1)
            )
        else:
            dist = haversine(
                sloc.get("lat", 0), sloc.get("lng", 0),
                eloc.get("lat", 0), eloc.get("lng", 0)
            )
        G.add_edge(s, e, waypoints=waypoints, weight=dist)
        graph_nodes.add(s)
        graph_nodes.add(e)

print(f"[INIT] Graph loaded: {len(graph_nodes)} nodes, {len(G.edges())} edges")

# ─────────────────────────────────────────────
# Load Indoor Map
# ─────────────────────────────────────────────

with open(os.path.join(_BASE, "indoor.json"), "r") as f:
    _indoor = json.load(f)

# ─────────────────────────────────────────────
# Session Management
# ─────────────────────────────────────────────

active_users = {}
session_lock = threading.Lock()

def cleanup_sessions():
    while True:
        time.sleep(600)
        cutoff = time.time() - 7200
        with session_lock:
            stale = [sid for sid, u in active_users.items() if u["last_active"] < cutoff]
            for sid in stale:
                del active_users[sid]

threading.Thread(target=cleanup_sessions, daemon=True).start()

# ─────────────────────────────────────────────
# Navigation Engine  (Google Maps-grade)
# ─────────────────────────────────────────────

def relative_direction(user_heading, target_bearing):
    """Map angle difference → turn word.  Tighter bands = less false turns."""
    diff = (target_bearing - user_heading + 360) % 360
    if diff < 20 or diff > 340:        return "straight"
    elif 20  <= diff < 50:             return "slight right"
    elif 50  <= diff < 130:            return "right"
    elif 130 <= diff <= 180:           return "sharp right"
    elif 180 < diff <= 230:            return "sharp left"
    elif 230 < diff < 310:             return "left"
    else:                              return "slight left"

def cardinal_direction(bear):
    """Return a compass word for a bearing — used when heading is unknown."""
    dirs = ["north","north-east","east","south-east",
            "south","south-west","west","north-west"]
    return dirs[int((bear + 22.5) / 45) % 8]

def smart_distance(meters):
    m = int(round(meters))
    if m < 10:          return "a few steps"
    elif m < 25:        return f"{m} meters"
    elif m < 100:       return f"{round(m/5)*5} meters"
    elif m < 500:       return f"{round(m/10)*10} meters"
    else:               return f"{round(m/50)*50} meters"

# Landmark phrases used instead of raw node names for intermediate waypoints
# Full node names are kept for destination announcements.
_TURN_VERBS = {
    "straight":     ("Continue straight",      "Continue straight"),
    "slight right": ("Keep slightly right",    "In {dist}, keep slightly right"),
    "right":        ("Turn right",             "In {dist}, turn right"),
    "sharp right":  ("Turn sharp right",       "In {dist}, turn sharp right"),
    "slight left":  ("Keep slightly left",     "In {dist}, keep slightly left"),
    "left":         ("Turn left",              "In {dist}, turn left"),
    "sharp left":   ("Turn sharp left",        "In {dist}, turn sharp left"),
}

def build_instruction(user_heading, road_bear, next_name,
                       distance_m, is_dest=False, prev_bear=None,
                       announce_type="current"):
    """
    announce_type:
      'current'   – main step instruction (e.g. "Turn right onto …")
      'upcoming'  – pre-turn warning     (e.g. "In 30 m, turn right")
      'continue'  – straight-line update (e.g. "Continue for 80 m")
    """
    dist_str  = smart_distance(distance_m)
    dest_word = "your destination" if is_dest else next_name

    # ── No heading available: use cardinal ──────────────────────────────
    if user_heading < 0:
        card = cardinal_direction(road_bear)
        if announce_type == "upcoming":
            return f"In {dist_str}, head {card} towards {dest_word}."
        return f"Head {card} for {dist_str} towards {dest_word}."

    direction = relative_direction(user_heading, road_bear)
    imm, pre  = _TURN_VERBS[direction]

    # ── Upcoming / pre-turn warning ─────────────────────────────────────
    if announce_type == "upcoming":
        return pre.replace("{dist}", dist_str) + f" towards {dest_word}."

    # ── Continue straight (no real turn) ────────────────────────────────
    if announce_type == "continue" or direction == "straight":
        return f"Continue for {dist_str}."

    # ── Turn instruction ────────────────────────────────────────────────
    if is_dest:
        return f"{imm}. Your destination, {next_name}, will be on your {'right' if 'right' in direction else 'left' if 'left' in direction else 'ahead'}."
    return f"{imm} and continue for {dist_str} towards {dest_word}."

# ─────────────────────────────────────────────
# API Endpoints
# ─────────────────────────────────────────────

@app.route("/locations", methods=["GET"])
def get_locations():
    locs = []
    for loc_id, loc in campus_data["locations"].items():
        cid = loc_id.strip()
        if cid not in graph_nodes or "lat" not in loc:
            continue
        locs.append({"id": cid, "name": loc["name"].strip()})
    locs.sort(key=lambda x: x["name"])
    return jsonify(locs)

@app.route("/nearest_location", methods=["POST"])
def nearest_location():
    data = request.json
    lat, lng = data["lat"], data["lng"]
    best_dist, best_id, best_name = float("inf"), None, None
    for loc_id, loc in campus_data["locations"].items():
        cid = loc_id.strip()
        if cid not in graph_nodes or "lat" not in loc:
            continue
        d = haversine(lat, lng, loc["lat"], loc["lng"])
        if d < best_dist:
            best_dist, best_id, best_name = d, cid, loc["name"].strip()
    if best_id:
        return jsonify({"location_id": best_id, "name": best_name, "distance_m": round(best_dist, 1)})
    return jsonify({"error": "Could not determine your campus location."})

@app.route("/start_navigation", methods=["POST"])
def start_navigation():
    data  = request.json
    start = data["start"].strip()
    dest  = data["destination"].strip()
    print(f"[NAV] {start} → {dest}")
    try:
        path = list(nx.shortest_path(G, start, dest, weight="weight"))
    except nx.NetworkXNoPath:
        return jsonify({"error": "No path found between these locations."})
    except nx.NodeNotFound as ex:
        return jsonify({"error": f"Location not found: {str(ex)}"})

    # ── Build road geometry per step ──────────────────────────────────
    road_geometry = []
    for i in range(len(path) - 1):
        edge_data = G.get_edge_data(path[i], path[i+1]) or {}
        wps = edge_data.get("waypoints", [])
        road_geometry.append(wps)

    # ── Build rich flat waypoint list ─────────────────────────────────
    # Each wp: lat, lng, bearing_out, is_turn, turn_angle,
    #          node_idx, next_node_name, is_dest_node
    TURN_THRESHOLD = 25   # degrees — tighter = fewer false turn announcements

    flat_wps = []

    for i in range(len(path) - 1):
        edge_data   = G.get_edge_data(path[i], path[i+1]) or {}
        wps         = edge_data.get("waypoints", [])
        is_last_seg = (i == len(path) - 2)
        node_name   = campus_data["locations"][path[i+1]]["name"].strip()

        if not wps or len(wps) < 2:
            a = campus_data["locations"][path[i]]
            b = campus_data["locations"][path[i+1]]
            wps = [[a["lat"], a["lng"]], [b["lat"], b["lng"]]]

        for j in range(len(wps) - 1):
            pt      = wps[j]
            pt_next = wps[j + 1]
            bear_out = bearing(pt[0], pt[1], pt_next[0], pt_next[1])

            # Turn angle relative to previous segment
            if flat_wps:
                prev_bear  = flat_wps[-1]["bearing"]
                turn_angle = (bear_out - prev_bear + 360) % 360
                if turn_angle > 180: turn_angle -= 360   # signed: negative=left
                abs_turn   = abs(turn_angle)
                is_turn    = abs_turn > TURN_THRESHOLD
            else:
                turn_angle = 0
                abs_turn   = 0
                is_turn    = False

            flat_wps.append({
                "lat":            pt[0],
                "lng":            pt[1],
                "bearing":        bear_out,
                "is_turn":        is_turn,
                "turn_angle":     round(turn_angle, 1),
                "node_idx":       i,
                "next_node_name": node_name,
                "is_dest_node":   is_last_seg and (j == len(wps) - 2),
            })

    # Final destination point
    dest_loc = campus_data["locations"][path[-1]]
    flat_wps.append({
        "lat":            dest_loc["lat"],
        "lng":            dest_loc["lng"],
        "bearing":        flat_wps[-1]["bearing"] if flat_wps else 0,
        "is_turn":        False,
        "turn_angle":     0,
        "node_idx":       len(path) - 1,
        "next_node_name": dest_loc["name"].strip(),
        "is_dest_node":   True,
    })

    sid = str(uuid.uuid4())
    with session_lock:
        active_users[sid] = {
            "route":          path,
            "step":           0,
            "wp_idx":         0,
            "flat_wps":       flat_wps,
            "last_active":    time.time(),
            "last_step_time": 0,
        }

    return jsonify({
        "session_id":    sid,
        "route":         path,
        "total_steps":   len(path) - 1,
        "road_geometry": road_geometry,
    })

@app.route("/update_location", methods=["POST"])
def update_location():
    data         = request.json
    sid          = data["session_id"]
    lat, lng     = data["lat"], data["lng"]
    user_heading = data.get("heading", -1)
    accuracy_m   = data.get("accuracy", 999)   # GPS accuracy radius from browser

    with session_lock:
        user = active_users.get(sid)
        if not user:
            return jsonify({"error": "Invalid or expired session."})
        flat_wps = user["flat_wps"]
        wp_idx   = user["wp_idx"]
        step     = user["step"]
        route    = user["route"]
        user["last_active"] = time.time()

        # ── GPS smoothing: exponential moving average ─────────────────
        sm_lat = user.get("sm_lat", lat)
        sm_lng = user.get("sm_lng", lng)
        # Less smoothing when GPS is accurate, more when noisy
        alpha = max(0.3, min(0.7, 15.0 / max(accuracy_m, 1)))
        sm_lat = alpha * lat + (1 - alpha) * sm_lat
        sm_lng = alpha * lng + (1 - alpha) * sm_lng
        user["sm_lat"] = sm_lat
        user["sm_lng"] = sm_lng

    # Use smoothed position for all calculations
    slat, slng = sm_lat, sm_lng

    if step >= len(route) - 1:
        return jsonify({"instruction": "Navigation complete.", "step": step})

    # ── Snap-to-road: find the closest waypoint segment ───────────────
    # Look ahead up to 6 waypoints to prevent backward snapping
    LOOKAHEAD  = 8
    ARRIVE_DIST = 14   # metres — reach this → advance waypoint

    while wp_idx < len(flat_wps) - 1:
        wp = flat_wps[wp_idx]
        if haversine(slat, slng, wp["lat"], wp["lng"]) < ARRIVE_DIST:
            wp_idx += 1
        else:
            break

    with session_lock:
        u = active_users.get(sid)
        if u:
            u["wp_idx"] = wp_idx

    wp        = flat_wps[wp_idx]
    dist_wp   = haversine(slat, slng, wp["lat"], wp["lng"])
    road_bear = wp["bearing"]

    # ── Destination distance ──────────────────────────────────────────
    final_loc    = campus_data["locations"][route[-1]]
    dist_to_dest = haversine(slat, slng, final_loc["lat"], final_loc["lng"])
    arrived      = dist_to_dest < 15

    # ── Step advancement ──────────────────────────────────────────────
    new_step = wp["node_idx"]
    if new_step != step:
        with session_lock:
            u = active_users.get(sid)
            if u and time.time() - u.get("last_step_time", 0) > 4:
                u["step"] = new_step
                u["last_step_time"] = time.time()
                step = new_step

    # ── Distance to next named node ───────────────────────────────────
    next_node_loc = campus_data["locations"][route[min(step + 1, len(route)-1)]]
    dist_to_node  = haversine(slat, slng, next_node_loc["lat"], next_node_loc["lng"])
    next_name     = wp["next_node_name"]
    is_dest       = wp.get("is_dest_node", False) or (step >= len(route) - 2)

    # ── Look-ahead: is there a significant turn coming up? ────────────
    upcoming_turn  = None
    upcoming_dist  = None
    for look in range(wp_idx + 1, min(wp_idx + LOOKAHEAD, len(flat_wps))):
        candidate = flat_wps[look]
        if candidate["is_turn"] and abs(candidate["turn_angle"]) > 35:
            d = haversine(slat, slng, candidate["lat"], candidate["lng"])
            if 15 < d < 80:     # only announce if 15-80 m away
                upcoming_turn = candidate
                upcoming_dist = d
                break

    # ── Choose instruction type ───────────────────────────────────────
    # 1) Current turn: the wp we're at IS a turn point
    # 2) Upcoming pre-warning: a turn is coming in 15-80 m
    # 3) Continue straight
    if wp["is_turn"] and dist_wp < 20:
        ann_type = "current"
    elif upcoming_turn and upcoming_dist:
        ann_type = "upcoming"
        road_bear = upcoming_turn["bearing"]
        next_name = upcoming_turn["next_node_name"]
        dist_to_node = upcoming_dist
        is_dest = upcoming_turn.get("is_dest_node", False)
    else:
        ann_type = "continue"

    instruction = build_instruction(
        user_heading, road_bear, next_name,
        dist_to_node, is_dest=is_dest,
        announce_type=ann_type
    )

    # ── Off-route detection ──────────────────────────────────────────
    # Check perpendicular distance from smoothed position to route polyline
    OFF_ROUTE_THRESHOLD = 35   # metres off the route line → trigger warning
    OFF_ROUTE_CONFIRM   = 3    # consecutive off-route ticks before alerting

    route_deviation = dist_to_route(slat, slng, flat_wps, wp_idx)
    with session_lock:
        u = active_users.get(sid)
        if u:
            if route_deviation > OFF_ROUTE_THRESHOLD:
                u["off_route_count"] = u.get("off_route_count", 0) + 1
            else:
                u["off_route_count"] = 0
            off_route_count = u.get("off_route_count", 0)

    off_route = off_route_count >= OFF_ROUTE_CONFIRM

    return jsonify({
        "instruction":    instruction,
        "distance":       round(dist_to_node, 1),
        "step":           step,
        "arrived":        arrived,
        "target_bearing": round(road_bear, 1),
        "next_location":  next_name,
        "announce_type":  ann_type,
        "accuracy":       round(accuracy_m, 1),
        "off_route":      off_route,
        "route_deviation": round(route_deviation, 1),
    })

# ─────────────────────────────────────────────
# Recalculate Route (off-route recovery)
# ─────────────────────────────────────────────

@app.route("/recalculate", methods=["POST"])
def recalculate():
    """Called when user is off-route. Finds nearest node and recomputes path."""
    data  = request.json
    sid   = data["session_id"]
    lat   = data["lat"]
    lng   = data["lng"]

    with session_lock:
        user = active_users.get(sid)
        if not user:
            return jsonify({"error": "Invalid session."})
        dest_node = user["route"][-1]

    # Find nearest graph node to current position
    best_dist, best_node = float("inf"), None
    for node_id in graph_nodes:
        loc = campus_data["locations"].get(node_id, {})
        if "lat" not in loc: continue
        d = haversine(lat, lng, loc["lat"], loc["lng"])
        if d < best_dist:
            best_dist, best_node = d, node_id

    if not best_node:
        return jsonify({"error": "Cannot find nearby campus location."})

    try:
        new_path = list(nx.shortest_path(G, best_node, dest_node, weight="weight"))
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        return jsonify({"error": "Cannot recalculate route."})

    # Rebuild road geometry and flat waypoints
    road_geometry = []
    for i in range(len(new_path) - 1):
        edge_data = G.get_edge_data(new_path[i], new_path[i+1]) or {}
        road_geometry.append(edge_data.get("waypoints", []))

    TURN_THRESHOLD = 25
    flat_wps = []
    for i in range(len(new_path) - 1):
        edge_data   = G.get_edge_data(new_path[i], new_path[i+1]) or {}
        wps         = edge_data.get("waypoints", [])
        is_last_seg = (i == len(new_path) - 2)
        node_name   = campus_data["locations"][new_path[i+1]]["name"].strip()
        if not wps or len(wps) < 2:
            a = campus_data["locations"][new_path[i]]
            b = campus_data["locations"][new_path[i+1]]
            wps = [[a["lat"], a["lng"]], [b["lat"], b["lng"]]]
        for j in range(len(wps) - 1):
            pt, pt_next = wps[j], wps[j+1]
            bear_out  = bearing(pt[0], pt[1], pt_next[0], pt_next[1])
            if flat_wps:
                prev_bear  = flat_wps[-1]["bearing"]
                turn_angle = (bear_out - prev_bear + 360) % 360
                if turn_angle > 180: turn_angle -= 360
                is_turn = abs(turn_angle) > TURN_THRESHOLD
            else:
                turn_angle, is_turn = 0, False
            flat_wps.append({
                "lat": pt[0], "lng": pt[1], "bearing": bear_out,
                "is_turn": is_turn, "turn_angle": round(turn_angle, 1),
                "node_idx": i, "next_node_name": node_name,
                "is_dest_node": is_last_seg and j == len(wps) - 2,
            })

    dest_loc = campus_data["locations"][new_path[-1]]
    flat_wps.append({
        "lat": dest_loc["lat"], "lng": dest_loc["lng"],
        "bearing": flat_wps[-1]["bearing"] if flat_wps else 0,
        "is_turn": False, "turn_angle": 0,
        "node_idx": len(new_path) - 1,
        "next_node_name": dest_loc["name"].strip(),
        "is_dest_node": True,
    })

    with session_lock:
        u = active_users.get(sid)
        if u:
            u["route"]    = new_path
            u["step"]     = 0
            u["wp_idx"]   = 0
            u["flat_wps"] = flat_wps
            u["sm_lat"]   = lat
            u["sm_lng"]   = lng

    return jsonify({
        "route":         new_path,
        "total_steps":   len(new_path) - 1,
        "road_geometry": road_geometry,
        "nearest_node":  best_node,
    })

# ─────────────────────────────────────────────
# Indoor Navigation Endpoints
# ─────────────────────────────────────────────

@app.route("/indoor/locations", methods=["GET"])
def indoor_locations():
    return jsonify(_indoor["locations"])

@app.route("/indoor/route", methods=["POST"])
def indoor_route():
    data  = request.json
    start = data.get("start", "").strip()
    dest  = data.get("destination", "").strip()
    key   = start + "→" + dest
    if key in _indoor["routes"]:
        return jsonify({"steps": _indoor["routes"][key], "found": True})
    rev = dest + "→" + start
    if rev in _indoor["routes"]:
        return jsonify({"steps": list(reversed(_indoor["routes"][rev])), "found": True})
    return jsonify({"found": False, "message": "No indoor route found."})

@app.route("/indoor/navigate", methods=["POST"])
def indoor_navigate():
    data  = request.json
    start = data.get("start", "").strip()
    dests = []
    for key in _indoor["routes"]:
        if key.startswith(start + "→"):
            dest_id = key.split("→")[1]
            name = _indoor["locations"].get(dest_id, {}).get("name", "")
            if not name:
                name = campus_data["locations"].get(dest_id, {}).get("name", dest_id)
            dests.append({"id": dest_id, "name": name})
    return jsonify({"destinations": dests})

# ─────────────────────────────────────────────
# Static Files
# ─────────────────────────────────────────────

@app.route("/")
def home():   return send_from_directory(_BASE, "index.html")

@app.route("/script.js")
def script(): return send_from_directory(_BASE, "script.js")

@app.route("/style.css")
def style():  return send_from_directory(_BASE, "style.css")

@app.route("/debug", methods=["GET"])
def debug():
    return jsonify({
        "node_count": len(graph_nodes),
        "edge_count": len(G.edges()),
        "nodes":      sorted(graph_nodes)
    })

if __name__ == "__main__":
    app.run(debug=True)
