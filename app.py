from flask import Flask, request, jsonify, send_from_directory
import json
import networkx as nx
import uuid
import time
import threading
from math import radians, sin, cos, sqrt, atan2, degrees
import os

app = Flask(__name__)

# -------------------------
# Load Campus Map
# -------------------------

_BASE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(_BASE, "campus.json"), "r") as f:
    campus_data = json.load(f)

G = nx.DiGraph()
graph_nodes = set()

for start, connections in campus_data["paths"].items():
    for end, instruction in connections.items():
        G.add_edge(start.strip(), end.strip(), instruction=instruction)
        graph_nodes.add(start.strip())
        graph_nodes.add(end.strip())

# -------------------------
# Active User Sessions
# -------------------------

active_users = {}
session_lock = threading.Lock()

# Auto-cleanup sessions older than 2 hours
def cleanup_sessions():
    while True:
        time.sleep(600)  # every 10 minutes
        now = time.time()
        with session_lock:
            to_delete = [
                sid for sid, s in active_users.items()
                if now - s.get("last_active", now) > 7200
            ]
            for sid in to_delete:
                del active_users[sid]

cleanup_thread = threading.Thread(target=cleanup_sessions, daemon=True)
cleanup_thread.start()

# -------------------------
# Distance Calculation (Haversine)
# -------------------------

def calculate_distance(lat1, lon1, lat2, lon2):
    R = 6371000
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat/2)**2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon/2)**2
    return R * 2 * atan2(sqrt(a), sqrt(1 - a))

# -------------------------
# Bearing Calculation
# -------------------------

def calculate_bearing(lat1, lon1, lat2, lon2):
    """Returns compass bearing (0-360) from point1 to point2."""
    lat1, lat2 = radians(lat1), radians(lat2)
    dlon = radians(lon2 - lon1)
    x = sin(dlon) * cos(lat2)
    y = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dlon)
    bearing = degrees(atan2(x, y))
    return (bearing + 360) % 360

# -------------------------
# Dynamic Direction
# -------------------------

def get_relative_direction(user_heading, target_bearing):
    """
    Given user's current heading and the bearing to the target,
    return a human-readable relative direction.
    """
    diff = (target_bearing - user_heading + 360) % 360

    if diff < 25 or diff > 335:
        return "straight"
    elif 25 <= diff < 80:
        return "slight right"
    elif 80 <= diff < 135:
        return "right"
    elif 135 <= diff <= 180:
        return "sharp right"
    elif 180 < diff <= 225:
        return "sharp left"
    elif 225 < diff < 280:
        return "left"
    elif 280 <= diff <= 335:
        return "slight left"
    return "straight"

def build_dynamic_instruction(user_heading, target_bearing, next_name, distance_m):
    """Build a direction instruction relative to user's current heading."""
    direction = get_relative_direction(user_heading, target_bearing)

    dist_str = str(int(round(distance_m))) + " meters"

    if direction == "straight":
        return f"Continue straight for {dist_str} to reach {next_name}."
    elif direction == "slight right":
        return f"In {dist_str}, bear slightly right towards {next_name}."
    elif direction == "right":
        return f"In {dist_str}, turn right towards {next_name}."
    elif direction == "sharp right":
        return f"In {dist_str}, take a sharp right towards {next_name}."
    elif direction == "slight left":
        return f"In {dist_str}, bear slightly left towards {next_name}."
    elif direction == "left":
        return f"In {dist_str}, turn left towards {next_name}."
    elif direction == "sharp left":
        return f"In {dist_str}, take a sharp left towards {next_name}."
    else:
        return f"Turn around and walk {dist_str} to reach {next_name}."

# -------------------------
# Get All Navigable Locations
# -------------------------

@app.route("/locations", methods=["GET"])
def get_locations():
    locs = []
    for loc_id, data in campus_data["locations"].items():
        clean_id = loc_id.strip()
        if clean_id not in graph_nodes:
            continue
        locs.append({"id": clean_id, "name": data["name"].strip()})
    locs.sort(key=lambda x: x["name"])
    return jsonify(locs)

# -------------------------
# Find Nearest Location to GPS
# -------------------------

@app.route("/nearest_location", methods=["POST"])
def nearest_location():
    data = request.json
    lat  = data["lat"]
    lng  = data["lng"]

    min_dist = float("inf")
    nearest_id   = None
    nearest_name = None

    for loc_id, loc_data in campus_data["locations"].items():
        clean_id = loc_id.strip()
        if clean_id not in graph_nodes:
            continue
        if "lat" not in loc_data or "lng" not in loc_data:
            continue
        dist = calculate_distance(lat, lng, loc_data["lat"], loc_data["lng"])
        if dist < min_dist:
            min_dist    = dist
            nearest_id   = clean_id
            nearest_name = loc_data["name"].strip()

    if nearest_id:
        return jsonify({
            "location_id": nearest_id,
            "name":        nearest_name,
            "distance_m":  round(min_dist, 1)
        })
    return jsonify({"error": "Could not determine your campus location."})

# -------------------------
# Start Navigation
# -------------------------

@app.route("/start_navigation", methods=["POST"])
def start_navigation():
    data  = request.json
    start = data["start"].strip()
    dest  = data["destination"].strip()

    # Debug: log what we received
    print(f"[NAV] start={repr(start)} dest={repr(dest)} in_graph={start in G.nodes()} {dest in G.nodes()}")

    try:
        path = list(nx.shortest_path(G, start, dest))
    except nx.NetworkXNoPath:
        return jsonify({"error": f"No path: {start} -> {dest}. Graph has {len(G.nodes())} nodes."})
    except nx.NodeNotFound as e:
        return jsonify({"error": f"Node missing: {str(e)}. Received start={repr(start)} dest={repr(dest)}"})

    session_id = str(uuid.uuid4())
    with session_lock:
        active_users[session_id] = {
            "route":       path,
            "step":        0,
            "last_active": time.time()
        }

    return jsonify({"session_id": session_id, "route": path, "total_steps": len(path) - 1})

# -------------------------
# Update GPS Location
# -------------------------

@app.route("/update_location", methods=["POST"])
def update_location():
    data       = request.json
    session_id = data["session_id"]
    lat        = data["lat"]
    lng        = data["lng"]
    # user_heading: bearing of movement, sent from client (-1 if unknown)
    user_heading = data.get("heading", -1)

    with session_lock:
        user = active_users.get(session_id)
        if not user:
            return jsonify({"error": "Invalid or expired session."})

        route = user["route"]
        step  = user["step"]
        user["last_active"] = time.time()

    if step >= len(route) - 1:
        return jsonify({"instruction": "Navigation complete.", "step": step})

    current   = route[step]
    next_node = route[step + 1]

    target     = campus_data["locations"][next_node]
    target_lat = target["lat"]
    target_lng = target["lng"]
    next_name  = target["name"].strip()

    distance        = calculate_distance(lat, lng, target_lat, target_lng)
    target_bearing  = calculate_bearing(lat, lng, target_lat, target_lng)

    # Use static instruction from graph (direction only, no distance)
    # Distance is shown separately on screen - avoids voice saying "91m...90m...89m"
    static_instruction = G[current][next_node]["instruction"]

    # Build dynamic turn direction only (no distance embedded in text)
    if user_heading >= 0:
        direction = get_relative_direction(user_heading, target_bearing)
        if direction == "straight":
            instruction = f"Continue straight towards {next_name}."
        elif direction in ("slight right", "right", "sharp right"):
            instruction = f"Turn {direction} towards {next_name}."
        elif direction in ("slight left", "left", "sharp left"):
            instruction = f"Turn {direction} towards {next_name}."
        else:
            instruction = static_instruction
    else:
        instruction = static_instruction

    # Advance step when close enough
    # 15m threshold — GPS on phones has ±5-10m natural drift, 5m was too aggressive
    arrived = distance < 15
    if arrived:
        with session_lock:
            if session_id in active_users:
                user_now = active_users[session_id]
                last_step_time = user_now.get("last_step_time", 0)
                # Enforce minimum 8 seconds between step advances to prevent GPS drift skipping steps
                if time.time() - last_step_time > 8:
                    user_now["step"] += 1
                    user_now["last_step_time"] = time.time()
                    step += 1

    return jsonify({
        "instruction":     instruction,
        "distance":        round(distance, 1),
        "step":            step,
        "arrived":         arrived,
        "target_bearing":  round(target_bearing, 1),
        "next_location":   next_name
    })

# -------------------------
# Debug Endpoint (check graph health)
# -------------------------

@app.route("/debug", methods=["GET"])
def debug():
    nodes = sorted(G.nodes())
    return jsonify({
        "node_count":   len(nodes),
        "edge_count":   len(G.edges()),
        "nodes":        nodes,
        "sample_edge":  list(G.edges())[:3]
    })

# -------------------------
# Serve Web App
# -------------------------

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

@app.route("/")
def home():
    return send_from_directory(BASE_DIR, "index.html")

@app.route("/script.js")
def script():
    return send_from_directory(BASE_DIR, "script.js")

@app.route("/style.css")
def style():
    return send_from_directory(BASE_DIR, "style.css")

# -------------------------

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
