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
# Load Campus & Indoor Maps
# ─────────────────────────────────────────────

_BASE = os.path.dirname(os.path.abspath(__file__))

with open(os.path.join(_BASE, "campus.json"), "r") as f:
    campus_data = json.load(f)

with open(os.path.join(_BASE, "indoor.json"), "r") as f:
    _indoor = json.load(f)

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
                haversine(waypoints[i][0], waypoints[i][1], waypoints[i+1][0], waypoints[i+1][1])
                for i in range(len(waypoints) - 1)
            )
        else:
            dist = haversine(sloc.get("lat", 0), sloc.get("lng", 0), eloc.get("lat", 0), eloc.get("lng", 0))
        G.add_edge(s, e, waypoints=waypoints, weight=dist)
        graph_nodes.add(s)
        graph_nodes.add(e)

print(f"[INIT] Graph loaded: {len(graph_nodes)} nodes, {len(G.edges())} edges")

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
            for sid in stale: del active_users[sid]

threading.Thread(target=cleanup_sessions, daemon=True).start()

# ─────────────────────────────────────────────
# Navigation Engine (The "Brain")
# ─────────────────────────────────────────────

def relative_direction(user_heading, target_bearing):
    diff = (target_bearing - user_heading + 360) % 360
    if diff < 20 or diff > 340:        return "straight"
    elif 20  <= diff < 50:             return "slight right"
    elif 50  <= diff < 130:            return "right"
    elif 130 <= diff <= 180:           return "sharp right"
    elif 180 < diff <= 230:            return "sharp left"
    elif 230 < diff < 310:             return "left"
    else:                              return "slight left"

def cardinal_direction(bear):
    dirs = ["north","north-east","east","south-east","south","south-west","west","north-west"]
    return dirs[int((bear + 22.5) / 45) % 8]

def smart_distance(meters):
    m = int(round(meters))
    if m < 10:          return "a few steps"
    elif m < 25:        return f"{m} meters"
    elif m < 100:       return f"{round(m/5)*5} meters"
    else:               return f"{round(m/10)*10} meters"

_TURN_VERBS = {
    "straight":     ("Continue straight",      "Continue straight"),
    "slight right": ("Keep slightly right",    "In {dist}, keep slightly right"),
    "right":        ("Turn right",             "In {dist}, turn right"),
    "sharp right":  ("Turn sharp right",       "In {dist}, turn sharp right"),
    "slight left":  ("Keep slightly left",     "In {dist}, keep slightly left"),
    "left":         ("Turn left",              "In {dist}, turn left"),
    "sharp left":   ("Turn sharp left",        "In {dist}, turn sharp left"),
}

def build_instruction(user_heading, road_bear, next_name, distance_m, is_dest=False, announce_type="current"):
    dist_str  = smart_distance(distance_m)
    dest_word = "your destination" if is_dest else next_name

    if user_heading < 0:
        card = cardinal_direction(road_bear)
        if announce_type == "upcoming": return f"In {dist_str}, head {card} towards {dest_word}."
        return f"Head {card} for {dist_str} towards {dest_word}."

    direction = relative_direction(user_heading, road_bear)
    imm, pre  = _TURN_VERBS[direction]

    if announce_type == "upcoming":
        return pre.replace("{dist}", dist_str) + f" towards {dest_word}."

    if announce_type == "continue" or direction == "straight":
        return f"Continue for {dist_str}."

    if is_dest:
        return f"{imm}. Your destination, {next_name}, will be on your {'right' if 'right' in direction else 'left' if 'left' in direction else 'ahead'}."
    return f"{imm} and continue for {dist_str} towards {dest_word}."

# ─────────────────────────────────────────────
# API Endpoints
# ─────────────────────────────────────────────

@app.route("/locations", methods=["GET"])
def get_locations():
    locs = [{"id": loc_id.strip(), "name": loc["name"].strip()} 
            for loc_id, loc in campus_data["locations"].items() 
            if loc_id.strip() in graph_nodes and "lat" in loc]
    return jsonify(sorted(locs, key=lambda x: x["name"]))

@app.route("/nearest_location", methods=["POST"])
def nearest_location():
    data = request.json
    lat, lng = data["lat"], data["lng"]
    best_dist, best_id, best_name = float("inf"), None, None
    for loc_id, loc in campus_data["locations"].items():
        if loc_id.strip() in graph_nodes and "lat" in loc:
            d = haversine(lat, lng, loc["lat"], loc["lng"])
            if d < best_dist:
                best_dist, best_id, best_name = d, loc_id.strip(), loc["name"].strip()
    
    if best_id: return jsonify({"location_id": best_id, "name": best_name, "distance_m": round(best_dist, 1)})
    return jsonify({"error": "Could not determine your campus location."})

@app.route("/start_navigation", methods=["POST"])
def start_navigation():
    data = request.json
    start, dest = data.get("start", "").strip(), data["destination"].strip()
    lat, lng = data.get("lat"), data.get("lng")

    # Smart Start: If no explicit start node, find nearest to GPS
    if not start and lat and lng:
        best_dist, start = float("inf"), None
        for loc_id, loc in campus_data["locations"].items():
            if loc_id.strip() in graph_nodes and "lat" in loc:
                d = haversine(lat, lng, loc["lat"], loc["lng"])
                if d < best_dist: best_dist, start = d, loc_id.strip()

    try:
        path = list(nx.shortest_path(G, start, dest, weight="weight"))
    except nx.NetworkXNoPath:
        return jsonify({"error": "No path found between these locations."})
    except nx.NodeNotFound as ex:
        return jsonify({"error": f"Location not found: {str(ex)}"})

    road_geometry, flat_wps = [], []
    TURN_THRESHOLD = 25

    for i in range(len(path) - 1):
        edge_data = G.get_edge_data(path[i], path[i+1]) or {}
        wps = edge_data.get("waypoints", [])
        node_name = campus_data["locations"][path[i+1]]["name"].strip()

        if not wps or len(wps) < 2:
            a, b = campus_data["locations"][path[i]], campus_data["locations"][path[i+1]]
            wps = [[a["lat"], a["lng"]], [b["lat"], b["lng"]]]
        road_geometry.append(wps)

        for j in range(len(wps) - 1):
            bear_out = bearing(wps[j][0], wps[j][1], wps[j+1][0], wps[j+1][1])
            is_turn, turn_angle = False, 0
            
            if flat_wps:
                turn_angle = (bear_out - flat_wps[-1]["bearing"] + 360) % 360
                if turn_angle > 180: turn_angle -= 360
                is_turn = abs(turn_angle) > TURN_THRESHOLD

            flat_wps.append({
                "lat": wps[j][0], "lng": wps[j][1], "bearing": bear_out,
                "is_turn": is_turn, "turn_angle": round(turn_angle, 1),
                "node_idx": i, "next_node_name": node_name,
                "is_dest_node": (i == len(path) - 2) and (j == len(wps) - 2)
            })

    dest_loc = campus_data["locations"][path[-1]]
    flat_wps.append({
        "lat": dest_loc["lat"], "lng": dest_loc["lng"],
        "bearing": flat_wps[-1]["bearing"] if flat_wps else 0,
        "is_turn": False, "turn_angle": 0, "node_idx": len(path) - 1,
        "next_node_name": dest_loc["name"].strip(), "is_dest_node": True
    })

    sid = str(uuid.uuid4())
    with session_lock:
        active_users[sid] = {
            "route": path, "step": 0, "wp_idx": 0, "flat_wps": flat_wps,
            "last_active": time.time(), "last_step_time": 0,
            "sm_lat": lat or campus_data["locations"][start]["lat"], 
            "sm_lng": lng or campus_data["locations"][start]["lng"]
        }

    return jsonify({"session_id": sid, "route": path, "total_steps": len(path) - 1, "road_geometry": road_geometry})

@app.route("/update_location", methods=["POST"])
def update_location():
    data = request.json
    sid = data["session_id"]
    lat, lng = data["lat"], data["lng"]
    user_heading = data.get("heading", -1)
    accuracy_m = data.get("accuracy", 999)

    with session_lock:
        user = active_users.get(sid)
        if not user: return jsonify({"error": "Invalid or expired session."})
        
        # ── 1. GPS Smoothing (EMA) ──
        alpha = max(0.3, min(0.7, 15.0 / max(accuracy_m, 1)))
        slat = alpha * lat + (1 - alpha) * user["sm_lat"]
        slng = alpha * lng + (1 - alpha) * user["sm_lng"]
        user["sm_lat"], user["sm_lng"], user["last_active"] = slat, slng, time.time()
        
        flat_wps, wp_idx, step, route = user["flat_wps"], user["wp_idx"], user["step"], user["route"]

    if step >= len(route) - 1:
        return jsonify({"instruction": "Navigation complete.", "step": step})

    # ── 2. Reroute Detection (Off-Route Check) ──
    best_dist_all, best_idx_all = float("inf"), wp_idx
    for i, check_wp in enumerate(flat_wps):
        d = haversine(slat, slng, check_wp["lat"], check_wp["lng"])
        if d < best_dist_all:
            best_dist_all, best_idx_all = d, i

    off_route = best_dist_all > 40

    if off_route:
        bear_to_route = bearing(slat, slng, flat_wps[best_idx_all]["lat"], flat_wps[best_idx_all]["lng"])
        direction = relative_direction(user_heading, bear_to_route) if user_heading >= 0 else "ahead"
        return jsonify({
            "instruction": f"You are off route. Head {direction} for {int(best_dist_all)} meters to return to the path.",
            "distance": round(best_dist_all, 1), "step": step, "arrived": False, "off_route": True
        })

    # ── 3. Snap-to-Road & Advance Waypoint ──
    while wp_idx < len(flat_wps) - 1:
        if haversine(slat, slng, flat_wps[wp_idx]["lat"], flat_wps[wp_idx]["lng"]) < 14:
            wp_idx += 1
        else: break

    with session_lock: active_users[sid]["wp_idx"] = wp_idx

    wp = flat_wps[wp_idx]
    dist_wp = haversine(slat, slng, wp["lat"], wp["lng"])
    road_bear = wp["bearing"]

    # ── 4. Arrival Check ──
    final_loc = campus_data["locations"][route[-1]]
    dist_to_dest = haversine(slat, slng, final_loc["lat"], final_loc["lng"])
    arrived = dist_to_dest < 15

    # ── 5. Step Advancement ──
    new_step = wp["node_idx"]
    if new_step != step:
        with session_lock:
            u = active_users.get(sid)
            if u and time.time() - u.get("last_step_time", 0) > 4:
                u["step"], u["last_step_time"], step = new_step, time.time(), new_step

    next_node_loc = campus_data["locations"][route[min(step + 1, len(route)-1)]]
    dist_to_node = haversine(slat, slng, next_node_loc["lat"], next_node_loc["lng"])
    next_name = wp["next_node_name"]
    is_dest = wp.get("is_dest_node", False) or (step >= len(route) - 2)

    # ── 6. Look-ahead logic for upcoming turns ──
    upcoming_turn, upcoming_dist = None, None
    for look in range(wp_idx + 1, min(wp_idx + 8, len(flat_wps))):
        candidate = flat_wps[look]
        if candidate["is_turn"] and abs(candidate["turn_angle"]) > 35:
            d = haversine(slat, slng, candidate["lat"], candidate["lng"])
            if 15 < d < 80:
                upcoming_turn, upcoming_dist = candidate, d
                break

    # ── 7. Determine Instruction Type ──
    if wp["is_turn"] and dist_wp < 20:
        ann_type = "current"
    elif upcoming_turn and upcoming_dist:
        ann_type, road_bear, next_name = "upcoming", upcoming_turn["bearing"], upcoming_turn["next_node_name"]
        dist_to_node, is_dest = upcoming_dist, upcoming_turn.get("is_dest_node", False)
    else:
        ann_type = "continue"

    instruction = build_instruction(user_heading, road_bear, next_name, dist_to_node, is_dest=is_dest, announce_type=ann_type)

    return jsonify({
        "instruction": instruction, "distance": round(dist_to_node, 1),
        "step": step, "arrived": arrived, "off_route": False,
        "target_bearing": round(road_bear, 1), "next_location": next_name,
        "announce_type": ann_type, "accuracy": round(accuracy_m, 1)
    })

# ─────────────────────────────────────────────
# Indoor Navigation Endpoints
# ─────────────────────────────────────────────

@app.route("/indoor/locations", methods=["GET"])
def indoor_locations():
    return jsonify(_indoor["locations"])

@app.route("/indoor/route", methods=["POST"])
def indoor_route():
    data, start, dest = request.json, request.json.get("start", "").strip(), request.json.get("destination", "").strip()
    key, rev = f"{start}→{dest}", f"{dest}→{start}"
    
    if key in _indoor["routes"]: return jsonify({"steps": _indoor["routes"][key], "found": True})
    if rev in _indoor["routes"]: return jsonify({"steps": list(reversed(_indoor["routes"][rev])), "found": True})
    
    return jsonify({"found": False, "message": "No indoor route found."})

@app.route("/indoor/navigate", methods=["POST"])
def indoor_navigate():
    start = request.json.get("start", "").strip()
    dests = []
    for key in _indoor["routes"]:
        if key.startswith(start + "→"):
            dest_id = key.split("→")[1]
            name = _indoor["locations"].get(dest_id, {}).get("name", campus_data["locations"].get(dest_id, {}).get("name", dest_id))
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
    return jsonify({"node_count": len(graph_nodes), "edge_count": len(G.edges()), "nodes": sorted(graph_nodes)})

if __name__ == "__main__":
    app.run(debug=True)
