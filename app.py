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


# ─────────────────────────────────────────────
# ─────────────────────────────────────────────
# Indoor Navigation
# ─────────────────────────────────────────────
with open(os.path.join(_BASE, "indoor.json"), "r") as _f:
    _indoor = json.load(_f)

@app.route("/indoor/locations", methods=["GET"])
def indoor_locations():
    return jsonify(_indoor["locations"])

@app.route("/indoor/route", methods=["POST"])
def indoor_route():
    data  = request.json
    start = data.get("start","").strip()
    dest  = data.get("destination","").strip()
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
    start = data.get("start","").strip()
    dests = []
    for key in _indoor["routes"]:
        if key.startswith(start + "→"):
            dest_id = key.split("→")[1]
            name = _indoor["locations"].get(dest_id, {}).get("name", "")
            if not name:
                name = campus_data["locations"].get(dest_id, {}).get("name", dest_id)
            dests.append({"id": dest_id, "name": name})
    return jsonify({"destinations": dests})

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
