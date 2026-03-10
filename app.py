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
# Load Campus Map
# ─────────────────────────────────────────────

_BASE = os.path.dirname(os.path.abspath(__file__))

with open(os.path.join(_BASE, "campus.json"), "r") as f:
    campus_data = json.load(f)

# Build directed graph from connectivity list
# New campus.json format: paths[start] = [end1, end2, ...]  (no instruction text)
G = nx.DiGraph()
graph_nodes = set()

for start, dests in campus_data["paths"].items():
    s = start.strip()
    for end, waypoints in dests.items():
        e = end.strip()
        # waypoints = list of [lat,lng] points along the real road
        G.add_edge(s, e, waypoints=waypoints)
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
        now = time.time()
        with session_lock:
            to_del = [sid for sid, s in active_users.items() if now - s.get("last_active", now) > 7200]
            for sid in to_del:
                del active_users[sid]

threading.Thread(target=cleanup_sessions, daemon=True).start()

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
# Dynamic Instruction Engine
# ─────────────────────────────────────────────

def relative_direction(user_heading, target_bearing):
    diff = (target_bearing - user_heading + 360) % 360
    if diff < 20 or diff > 340:       return "straight"
    elif 20  <= diff < 70:            return "slight right"
    elif 70  <= diff < 120:           return "right"
    elif 120 <= diff <= 180:          return "sharp right"
    elif 180 < diff <= 240:           return "sharp left"
    elif 240 < diff < 290:            return "left"
    else:                             return "slight left"

def smart_distance(meters):
    m = int(round(meters))
    if m < 10:   return "a few steps"
    elif m < 50: return f"{m} meters"
    else:        return f"about {round(m/5)*5} meters"

def compass_direction(bear):
    dirs = ["north","north-east","east","south-east","south","south-west","west","north-west"]
    return dirs[round(bear / 45) % 8]

def build_instruction(user_heading, target_bear, next_name, distance_m,
                      prev_lat=None, prev_lng=None, curr_lat=None, curr_lng=None):
    dist_str = smart_distance(distance_m)

    if user_heading >= 0:
        direction = relative_direction(user_heading, target_bear)
    elif prev_lat is not None and curr_lat is not None:
        inferred  = bearing(prev_lat, prev_lng, curr_lat, curr_lng)
        direction = relative_direction(inferred, target_bear)
    else:
        compass = compass_direction(target_bear)
        return f"Head {compass} for {dist_str} to reach {next_name}."

    phrases = {
        "straight":    f"Continue straight for {dist_str} to reach {next_name}.",
        "slight right":f"Bear slightly right and walk {dist_str} to {next_name}.",
        "right":       f"Turn right and walk {dist_str} to {next_name}.",
        "sharp right": f"Take a sharp right and walk {dist_str} to {next_name}.",
        "slight left": f"Bear slightly left and walk {dist_str} to {next_name}.",
        "left":        f"Turn left and walk {dist_str} to {next_name}.",
        "sharp left":  f"Take a sharp left and walk {dist_str} to {next_name}.",
    }
    return phrases.get(direction, f"Walk {dist_str} to reach {next_name}.")

# ─────────────────────────────────────────────
# API Endpoints
# ─────────────────────────────────────────────

@app.route("/locations", methods=["GET"])
def get_locations():
    locs = []
    for loc_id, data in campus_data["locations"].items():
        cid = loc_id.strip()
        if cid not in graph_nodes: continue
        locs.append({"id": cid, "name": data["name"].strip()})
    locs.sort(key=lambda x: x["name"])
    return jsonify(locs)

@app.route("/nearest_location", methods=["POST"])
def nearest_location():
    data = request.json
    lat, lng = data["lat"], data["lng"]
    best_dist, best_id, best_name = float("inf"), None, None
    for loc_id, loc in campus_data["locations"].items():
        cid = loc_id.strip()
        if cid not in graph_nodes or "lat" not in loc: continue
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
        path = list(nx.shortest_path(G, start, dest))
    except nx.NetworkXNoPath:
        return jsonify({"error": "No path found between these locations."})
    except nx.NodeNotFound as e:
        return jsonify({"error": f"Location not found: {str(e)}"})
    sid = str(uuid.uuid4())
    with session_lock:
        active_users[sid] = {"route": path, "step": 0,
                             "last_active": time.time(), "last_step_time": 0}
    # Build road geometry for the client to draw accurate route lines
    road_geometry = []
    for i in range(len(path) - 1):
        edge_data = G.get_edge_data(path[i], path[i+1]) or {}
        wps = edge_data.get("waypoints", [])
        road_geometry.append(wps)  # empty list = draw straight line

    return jsonify({
        "session_id":    sid,
        "route":         path,
        "total_steps":   len(path) - 1,
        "road_geometry": road_geometry
    })

@app.route("/update_location", methods=["POST"])
def update_location():
    data         = request.json
    sid          = data["session_id"]
    lat, lng     = data["lat"], data["lng"]
    user_heading = data.get("heading", -1)

    with session_lock:
        user = active_users.get(sid)
        if not user: return jsonify({"error": "Invalid or expired session."})
        route = user["route"]
        step  = user["step"]
        user["last_active"] = time.time()

    if step >= len(route) - 1:
        return jsonify({"instruction": "Navigation complete.", "step": step})

    current   = route[step]
    next_node = route[step + 1]
    next_loc  = campus_data["locations"][next_node]
    next_name = next_loc["name"].strip()

    dist = haversine(lat, lng, next_loc["lat"], next_loc["lng"])
    bear = bearing(lat, lng, next_loc["lat"], next_loc["lng"])

    # Previous waypoint coords for fallback heading inference
    prev_lat = prev_lng = None
    if step > 0:
        p = campus_data["locations"].get(route[step - 1], {})
        prev_lat, prev_lng = p.get("lat"), p.get("lng")

    instruction = build_instruction(
        user_heading, bear, next_name, dist,
        prev_lat=prev_lat, prev_lng=prev_lng,
        curr_lat=lat, curr_lng=lng
    )

    # Advance step when within 15m and at least 8s since last advance
    if dist < 15:
        with session_lock:
            u = active_users.get(sid)
            if u and time.time() - u.get("last_step_time", 0) > 8:
                u["step"] += 1
                u["last_step_time"] = time.time()
                step = u["step"]

    return jsonify({
        "instruction":    instruction,
        "distance":       round(dist, 1),
        "step":           step,
        "arrived":        dist < 15,
        "target_bearing": round(bear, 1),
        "next_location":  next_name
    })

@app.route("/debug", methods=["GET"])
def debug():
    return jsonify({
        "node_count": len(graph_nodes),
        "edge_count": len(G.edges()),
        "nodes":      sorted(graph_nodes)
    })

# ─────────────────────────────────────────────
# Serve Web App
# ─────────────────────────────────────────────

@app.route("/")
def home():   return send_from_directory(_BASE, "index.html")

@app.route("/script.js")
def script(): return send_from_directory(_BASE, "script.js")

@app.route("/style.css")
def style():  return send_from_directory(_BASE, "style.css")

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
