from flask import Flask, request, jsonify, send_from_directory
import json
import networkx as nx
import uuid
from math import radians, sin, cos, sqrt, atan2
import os

app = Flask(__name__)

# -------------------------
# Load Campus Map
# -------------------------

with open("campus.json", "r") as f:
    campus_data = json.load(f)

G = nx.DiGraph()

for start, connections in campus_data["paths"].items():
    for end, instruction in connections.items():
        G.add_edge(start, end, instruction=instruction)

# -------------------------
# Active User Sessions
# -------------------------

active_users = {}

# -------------------------
# Distance Calculation
# -------------------------

def calculate_distance(lat1, lon1, lat2, lon2):
    R = 6371000
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat/2)**2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon/2)**2
    c = 2 * atan2(sqrt(a), sqrt(1 - a))
    return R * c

# -------------------------
# Get All Locations (for dropdown)
# -------------------------

@app.route("/locations", methods=["GET"])
def get_locations():
    locs = []
    for loc_id, data in campus_data["locations"].items():
        locs.append({
            "id":   loc_id,
            "name": data["name"]
        })
    locs.sort(key=lambda x: x["name"])
    return jsonify(locs)

# -------------------------
# Start Navigation
# -------------------------

@app.route("/start_navigation", methods=["POST"])
def start_navigation():
    data  = request.json
    start = data["start"]
    dest  = data["destination"]

    try:
        path = list(nx.shortest_path(G, start, dest))
    except nx.NetworkXNoPath:
        return jsonify({"error": "No path found between these locations."})
    except nx.NodeNotFound:
        return jsonify({"error": "Invalid location ID."})

    session_id = str(uuid.uuid4())
    active_users[session_id] = {
        "route": path,
        "step":  0
    }

    return jsonify({
        "session_id": session_id,
        "route":      path
    })

# -------------------------
# Update GPS Location
# -------------------------

@app.route("/update_location", methods=["POST"])
def update_location():
    data       = request.json
    session_id = data["session_id"]
    lat        = data["lat"]
    lng        = data["lng"]

    user = active_users.get(session_id)
    if not user:
        return jsonify({"error": "Invalid or expired session."})

    route = user["route"]
    step  = user["step"]

    if step >= len(route) - 1:
        return jsonify({"instruction": "Navigation complete.", "step": step})

    current   = route[step]
    next_node = route[step + 1]

    target     = campus_data["locations"][next_node]
    target_lat = target["lat"]
    target_lng = target["lng"]

    distance    = calculate_distance(lat, lng, target_lat, target_lng)
    instruction = G[current][next_node]["instruction"]

    if distance < 5:
        user["step"] += 1

    return jsonify({
        "instruction": instruction,
        "distance":    round(distance, 1),
        "step":        step
    })

# -------------------------
# Serve Web App
# -------------------------

@app.route("/")
def home():
    return send_from_directory("../web", "index.html")

@app.route("/script.js")
def script():
    return send_from_directory("../web", "script.js")

@app.route("/style.css")
def style():
    return send_from_directory("../web", "style.css")

# -------------------------

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
