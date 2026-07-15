import base64

# ---------------------------------------------------------------------------
# Backup / Restore API
# ---------------------------------------------------------------------------

@app.route("/api/backup", methods=["GET"])
def backup_config():
    """Export full configuration including images as base64."""
    config = load_config()
    backup = {
        "version": "1.7.0",
        "exported_at": str(datetime.utcnow()),
        "floors": []
    }

    for floor in config.get("floors", []):
        floor_data = {
            "id": floor["id"],
            "name": floor["name"],
            "order": floor.get("order", 0),
            "elements": floor.get("elements", []),
            "image": None,
            "image_base64": None,
            "image_ext": None
        }

        if floor.get("image"):
            img_path = IMAGES_DIR / floor["image"]
            if img_path.exists():
                try:
                    with open(img_path, "rb") as f:
                        img_bytes = f.read()
                    floor_data["image_base64"] = base64.b64encode(img_bytes).decode("utf-8")
                    floor_data["image_ext"] = img_path.suffix
                except Exception as exc:
                    log.warning("Could not read image for backup: %s", exc)

        backup["floors"].append(floor_data)

    return jsonify(backup)


@app.route("/api/restore", methods=["POST"])
def restore_config():
    """Restore configuration from backup JSON."""
    data = request.get_json(force=True)

    if not data or "floors" not in data:
        return jsonify({"error": "Invalid backup file"}), 400

    new_config = {"floors": []}

    for floor_data in data["floors"]:
        floor = {
            "id": floor_data.get("id") or str(uuid.uuid4()),
            "name": floor_data.get("name", "Unnamed Floor"),
            "order": floor_data.get("order", 0),
            "elements": floor_data.get("elements", []),
            "image": None
        }

        # Restore image if present
        if floor_data.get("image_base64") and floor_data.get("image_ext"):
            try:
                img_bytes = base64.b64decode(floor_data["image_base64"])
                new_filename = uuid.uuid4().hex + floor_data["image_ext"]
                save_path = IMAGES_DIR / new_filename
                with open(save_path, "wb") as f:
                    f.write(img_bytes)
                floor["image"] = new_filename
            except Exception as exc:
                log.warning("Could not restore image: %s", exc)

        new_config["floors"].append(floor)

    # Save the restored config
    save_config(new_config)

    return jsonify({"ok": True, "message": "Configuration restored successfully"})
