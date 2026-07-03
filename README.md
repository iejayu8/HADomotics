# HADomotics

**Interactive home floor plan addon for Home Assistant**

HADomotics lets you upload a drawing of your home and place interactive buttons, lights, sensors, and indicators directly on the image. Everything is manageable from the addon's built-in configuration panel, and a Lovelace custom card displays your home plan with live entity states.

---

## Features

- 🏠 **Multi-floor support** – pre-configured floors for *Floor 1*, *Floor 2*, and *Garden*; add as many custom floors as you need
- 🖼️ **Floor plan images** – upload any JPEG, PNG, GIF, WebP, or SVG image as the background for each floor
- 🖱️ **Visual element placement** – click directly on the image to drop a new element (button, light, sensor, indicator, climate, cover, camera)
- ⚙️ **Rich element configuration** – set label, entity ID, icon (MDI), tap action, colors (on/off), and pixel dimensions
- 🔄 **Drag & resize** – reposition and resize elements by dragging them on the canvas
- 📊 **Real-time states** – the Lovelace card reflects live HA entity states and allows toggling with a single click
- 🎨 **Custom Lovelace card** – drop-in `hadomotics-card` custom element with multi-floor tab navigation

---

## Repository layout

```
HADomotics/
├── hadomotics/          ← Home Assistant addon
│   ├── config.yaml      ← Addon manifest
│   ├── build.yaml       ← Multi-arch build config
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── server.py        ← Flask REST API + static file server
│   ├── translations/
│   │   └── en.yaml
│   └── static/          ← Configuration panel frontend
│       ├── index.html
│       ├── css/style.css
│       └── js/app.js
└── lovelace-card/
    └── hadomotics-card.js  ← Lovelace custom card
```

---

## Installation

### 1. Add this repository as a custom addon repository

In Home Assistant go to **Settings → Add-ons → Add-on Store → ⋮ (overflow menu) → Repositories** and add:

```
https://github.com/iejayu8/HADomotics
```

Then find **HADomotics** in the store and click **Install**.

### 2. Install the Lovelace card

Copy `lovelace-card/hadomotics-card.js` to your HA `/config/www/` directory (create `www/` if it doesn't exist).

Then add it as a **Lovelace resource**:

- Go to **Settings → Dashboards → ⋮ → Manage resources**
- Add `/local/hadomotics-card.js` as a **JavaScript module**

---

## Configuration panel

After installation, open the **HADomotics** panel from the HA sidebar.

### Setting up floors

The addon ships with three default floors: **Floor 1**, **Floor 2**, and **Garden**.
Click **＋** in the *Floors* sidebar section to add more.

### Uploading a floor plan

1. Select a floor from the sidebar
2. Click **Upload Floor Plan** in the toolbar (or the placeholder in the canvas)
3. Choose a JPEG, PNG, WebP, GIF, or SVG image

### Placing elements

1. Select a floor that already has an image
2. Click **＋** in the *Elements* sidebar section – you'll enter placement mode
3. Click anywhere on the floor plan image to drop the element
4. The **Properties** panel opens on the right; fill in:
   - **Label** – display name shown on the overlay
   - **Type** – `button`, `light`, `sensor`, `indicator`, `climate`, `cover`, `camera`
   - **Entity ID** – e.g. `light.living_room`
   - **Icon** – any MDI icon name, e.g. `lightbulb`
   - **Color On / Off** – background colours for active/inactive states
   - **Tap Action** – `toggle`, `more-info`, `navigate`, or `none`
5. Click **Save**

### Moving / resizing elements

- **Drag** an element to reposition it
- **Drag the resize handle** (bottom-right corner) to resize it

---

## Lovelace card

Add the following to a Lovelace dashboard YAML:

```yaml
type: custom:hadomotics-card
title: My Home
addon_url: http://homeassistant.local:8099
default_floor: floor1   # optional – ID of the floor to show by default
```

| Property | Required | Description |
|---|---|---|
| `addon_url` | ✅ | Base URL of the HADomotics addon |
| `title` | | Card title (default: `HADomotics`) |
| `default_floor` | | Floor ID to select on load |

### Floor IDs

The default floors have IDs `floor1`, `floor2`, and `garden`.
Custom floors get a UUID as their ID – you can see it by inspecting the API at `http://<addon>/api/floors`.

---

## REST API

The addon exposes a simple REST API for integration and scripting:

| Method | Path | Description |
|---|---|---|
| GET | `/api/floors` | List all floors |
| POST | `/api/floors` | Create a floor `{ "name": "..." }` |
| GET | `/api/floors/{id}` | Get floor details + elements |
| PUT | `/api/floors/{id}` | Update floor `{ "name": "...", "order": 0 }` |
| DELETE | `/api/floors/{id}` | Delete floor and its elements |
| POST | `/api/floors/{id}/image` | Upload floor plan image (multipart `image` field) |
| DELETE | `/api/floors/{id}/image` | Remove floor plan image |
| GET | `/api/images/{filename}` | Serve a stored image |
| GET | `/api/floors/{id}/elements` | List elements on a floor |
| POST | `/api/floors/{id}/elements` | Add element |
| PUT | `/api/floors/{id}/elements/{eid}` | Update element |
| DELETE | `/api/floors/{id}/elements/{eid}` | Delete element |
| GET | `/api/ha/states` | Proxy: all HA entity states |
| GET | `/api/ha/states/{entity_id}` | Proxy: single entity state |
| POST | `/api/ha/services/{domain}/{service}` | Proxy: call HA service |

---

## Supported architectures

`amd64` · `aarch64` · `armv7` · `armhf`

**Version 1.2.5** - Fixed token handling in config panel view mode and synchronized versions.

---

## Development

```bash
cd hadomotics
pip install -r requirements.txt
DATA_DIR=/tmp/hadomotics python server.py
```

The server starts on `http://localhost:8099`.

---

## License

MIT
