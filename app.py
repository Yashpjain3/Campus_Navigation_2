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
# Math Helpers (defined early — used during graph init)
# ─────────────────────────────────────────────

def haversine(lat1, lon1, lat2, lon2):
    R = 6371000
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat/2)**2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon/2)**2
    return R * 2 * atan2(sqrt(a), sqrt(1 - a))

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
        # Calculate real-world distance for weighted shortest path
        sloc = campus_data["locations"].get(s, {})
        eloc = campus_data["locations"].get(e, {})
        # Use actual road length if waypoints available, else straight-line
        if waypoints and len(waypoints) >= 2:
            dist = sum(
                haversine(waypoints[i][0], waypoints[i][1],
                          waypoints[i+1][0], waypoints[i+1][1])
                for i in range(len(waypoints) - 1)
            )
        else:
            dist = haversine(
                sloc.get("lat",0), sloc.get("lng",0),
                eloc.get("lat",0), eloc.get("lng",0)
            )
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
        now = time.time()
        with session_lock:
            to_del = [sid for sid, s in active_users.items() if now - s.get("last_active", now) > 7200]
            for sid in to_del:
                del active_users[sid]

threading.Thread(target=cleanup_sessions, daemon=True).start()

# ─────────────────────────────────────────────
# Math Helpers (continued)
# ─────────────────────────────────────────────

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
    if diff < 25 or diff > 335:       return "straight"
    elif 25  <= diff < 65:            return "slight right"
    elif 65  <= diff < 115:           return "right"
    elif 115 <= diff <= 180:          return "sharp right"
    elif 180 < diff <= 245:           return "sharp left"
    elif 245 < diff < 295:            return "left"
    else:                             return "slight left"

def smart_distance(meters):
    m = int(round(meters))
    if m < 10:   return "a few steps"
    elif m < 50: return f"{m} meters"
    else:        return f"about {round(m/5)*5} meters"

def build_instruction(user_heading, road_bear, next_name, distance_m):
    """
    user_heading: where the phone is facing (degrees, -1 if unknown)
    road_bear:    the bearing of the road segment we need to walk along
    """
    dist_str = smart_distance(distance_m)

    if user_heading < 0:
        # No heading — just tell distance, no turn word
        return f"Walk {dist_str} towards {next_name}."

    direction = relative_direction(user_heading, road_bear)

    phrases = {
        "straight":     f"Go straight for {dist_str} towards {next_name}.",
        "slight right": f"Keep slightly right for {dist_str} towards {next_name}.",
        "right":        f"Turn right and walk {dist_str} to {next_name}.",
        "sharp right":  f"Take a sharp right and walk {dist_str} to {next_name}.",
        "slight left":  f"Keep slightly left for {dist_str} towards {next_name}.",
        "left":         f"Turn left and walk {dist_str} to {next_name}.",
        "sharp left":   f"Take a sharp left and walk {dist_str} to {next_name}.",
    }
    return phrases.get(direction, f"Walk {dist_str} towards {next_name}.")

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
        path = list(nx.shortest_path(G, start, dest, weight='weight'))
    except nx.NetworkXNoPath:
        return jsonify({"error": "No path found between these locations."})
    except nx.NodeNotFound as e:
        return jsonify({"error": f"Location not found: {str(e)}"})
    # Build road geometry for map display
    road_geometry = []
    for i in range(len(path) - 1):
        edge_data = G.get_edge_data(path[i], path[i+1]) or {}
        wps = edge_data.get("waypoints", [])
        road_geometry.append(wps)

    # Flatten ALL waypoints into one sequence with turn annotations.
    # Uses actual road geometry — not node-to-node bearings.
    TURN_THRESHOLD = 30   # degrees change that counts as a turn
    flat_wps = []

    for i in range(len(path) - 1):
        edge_data = G.get_edge_data(path[i], path[i+1]) or {}
        wps = edge_data.get("waypoints", [])
        node_name = campus_data["locations"][path[i+1]]["name"].strip()

        if not wps:
            a = campus_data["locations"][path[i]]
            b = campus_data["locations"][path[i+1]]
            wps = [[a["lat"], a["lng"]], [b["lat"], b["lng"]]]

        for j in range(len(wps) - 1):
            pt       = wps[j]
            pt_next  = wps[j + 1]
            bear_now = bearing(pt[0], pt[1], pt_next[0], pt_next[1])
            if flat_wps:
                diff     = (bear_now - flat_wps[-1]["bearing"] + 360) % 360
                is_turn  = not (diff < TURN_THRESHOLD or diff > 360 - TURN_THRESHOLD)
            else:
                diff, is_turn = 0, False
            flat_wps.append({
                "lat": pt[0], "lng": pt[1],
                "bearing": bear_now,
                "is_turn": is_turn,
                "diff": diff,
                "node_idx": i,
                "next_node_name": node_name
            })

    dest_loc = campus_data["locations"][path[-1]]
    flat_wps.append({
        "lat": dest_loc["lat"], "lng": dest_loc["lng"],
        "bearing": flat_wps[-1]["bearing"] if flat_wps else 0,
        "is_turn": False, "diff": 0,
        "node_idx": len(path) - 1,
        "next_node_name": dest_loc["name"].strip()
    })

    sid = str(uuid.uuid4())
    with session_lock:
        active_users[sid] = {
            "route":           path,
            "step":            0,
            "wp_idx":          0,
            "flat_wps":        flat_wps,
            "last_active":     time.time(),
            "last_step_time":  0
        }

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
        flat_wps  = user["flat_wps"]
        wp_idx    = user["wp_idx"]
        step      = user["step"]
        route     = user["route"]
        user["last_active"] = time.time()

    if step >= len(route) - 1:
        return jsonify({"instruction": "Navigation complete.", "step": step})

    # ── Advance wp_idx to closest upcoming waypoint ───────────────────
    # Skip any waypoints the user has already passed (within 12m)
    while wp_idx < len(flat_wps) - 1:
        wp = flat_wps[wp_idx]
        d_to_wp = haversine(lat, lng, wp["lat"], wp["lng"])
        if d_to_wp < 12:
            wp_idx += 1
        else:
            break

    with session_lock:
        u = active_users.get(sid)
        if u:
            u["wp_idx"] = wp_idx

    # ── Current target waypoint ───────────────────────────────────────
    wp      = flat_wps[wp_idx]
    dist    = haversine(lat, lng, wp["lat"], wp["lng"])
    road_bear = wp["bearing"]

    # ── Advance node step when entering a new node area ───────────────
    final_loc = campus_data["locations"][route[-1]]
    dist_to_dest = haversine(lat, lng, final_loc["lat"], final_loc["lng"])

    new_step = wp["node_idx"]
    if new_step != step:
        with session_lock:
            u = active_users.get(sid)
            if u and time.time() - u.get("last_step_time", 0) > 5:
                u["step"] = new_step
                u["last_step_time"] = time.time()
                step = new_step

    # ── Build instruction ─────────────────────────────────────────────
    next_node_name = wp["next_node_name"]

    # Distance to next NODE (for display), not just next waypoint
    next_node_loc = campus_data["locations"][route[min(step + 1, len(route)-1)]]
    dist_to_node  = haversine(lat, lng, next_node_loc["lat"], next_node_loc["lng"])

    instruction = build_instruction(user_heading, road_bear, next_node_name, dist_to_node)

    arrived = dist_to_dest < 15

    return jsonify({
        "instruction":    instruction,
        "distance":       round(dist_to_node, 1),
        "step":           step,
        "arrived":        arrived,
        "target_bearing": round(road_bear, 1),
        "next_location":  next_node_name
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
