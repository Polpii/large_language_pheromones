# Large Language Pheromones

A tamagotchi companion app that lives on your screen — and smells things in real life.

This project combines a pixel-art virtual pet with AI-powered multi-agent conversations, voice interaction, and a physical scent diffuser controlled over Bluetooth. There's also a Raspberry Pi client that renders the tamagotchi on a small SPI screen with LED animations and a push-to-talk button.

## What it does

- **Tamagotchi companion** — A pixel-art creature with different states (idle, listening, thinking, waving, dating). Each user gets a unique shape and color palette based on their name.
- **Voice interaction** — Hold a button (Pi) or press L (web) to talk. Audio is transcribed via Whisper and processed by GPT-4o.
- **Agent dating** — Your tamagotchi can "date" other users' tamagotchis. A multi-agent system runs conversations between AI versions of each user, scores compatibility, and picks the best match.
- **Scent recipes** — The AI generates scent sequences for each user profile. These get played on a real BLE scent diffuser device.
- **Raspberry Pi display** — A dedicated hardware client renders the tamagotchi on a 240×280 SPI screen (ST7789), with NeoPixel LED strip animations and button-triggered voice recording.

## Project structure

```
├── src/
│   ├── app/                 # Next.js pages and API routes
│   │   ├── page.tsx         # Homepage — user dashboard
│   │   ├── scent/           # Scent device control page
│   │   ├── user/            # Individual user pages
│   │   └── api/             # All API endpoints (see below)
│   ├── components/          # React components (CompanionScreen, Tamagotchi, etc.)
│   └── lib/                 # Shared utilities (OpenAI client, scent bridge, profiles)
├── raspberry/
│   └── client.py            # Pi client — display, LEDs, mic, speaker
├── scent-bridge/
│   └── server.py            # Python HTTP server that talks BLE to the scent device
├── data/                    # JSON storage (profiles, recipes, conversations, state)
└── public/                  # Static assets
```

## Getting started

### Prerequisites

- Node.js 18+
- An OpenAI API key

### Installation

```bash
npm install
```

Create a `.env.local` file at the root:

```
OPENAI_API_KEY=sk-...
```

Optionally, you can also set:

```
OPENAI_MODEL=gpt-4o          # defaults to gpt-4o
SCENT_BRIDGE_PORT=5050        # defaults to 5050
```

### Running the app

```bash
npm run dev
```

This starts the Next.js dev server on `0.0.0.0:3000` so it's accessible from your local network (useful for the Pi client).

Open [http://localhost:3000](http://localhost:3000) to get started.

### Keyboard shortcuts (web)

| Key | Action |
|-----|--------|
| **L** | Toggle voice input (start/stop listening) |
| **A** | Display art on the Pi screen for 30 seconds |

## Raspberry Pi setup

The Pi client renders the tamagotchi on a Seeed Studio ST7789 240×280 SPI display with a NeoPixel LED strip and a push-to-talk button.

### Hardware

- Raspberry Pi (tested on Pi 4)
- Seeed Studio 104990802 (ST7789 240×280 SPI screen)
- NeoPixel LED strip (30 pixels, data on GPIO13)
- Push button on GPIO26
- USB microphone
- Speaker (for MP3 playback via mpg123)

### Pi dependencies

```bash
pip3 install adafruit-circuitpython-rgb-display adafruit-circuitpython-neopixel
pip3 install Pillow requests sounddevice numpy gpiozero
sudo apt install mpg123
```

### Running the Pi client

```bash
cd raspberry
python3 client.py --server http://<your-pc-ip>:3000 --user elisa
```

The client polls the server for state changes, animates the tamagotchi on the display, and lights up the LED strip according to the current state. Hold the button to record a voice message — it gets transcribed and processed just like the web voice input.

### MP3 files

Place these in the `raspberry/` folder for sound effects:

- `wave.mp3` — plays when someone waves
- `listen.mp3` — plays when recording starts
- `dating.mp3` — loops during a date
- `heartbeat05.mp3`, `heartbeat1.mp3`, `heartbeat15.mp3` — heartbeat sequence on match
- `art.png` — image displayed when pressing A on the web app

## Scent bridge

The scent bridge is a small Python HTTP server that communicates with a BLE scent diffuser device. It's automatically started by the Next.js app when you visit the `/scent` page, but you can also run it manually:

```bash
cd scent-bridge
pip install bleak
python server.py --port 5050
```

The bridge exposes a simple REST API on port 5050:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Bridge status (fast, no BLE scan) |
| `/connect` | GET | Scan and connect to BLE device |
| `/play` | POST | Play a scent sequence |
| `/stop` | POST | Force stop all scent channels |

## API routes

| Route | Description |
|-------|-------------|
| `POST /api/listen` | Process a voice transcription |
| `POST /api/transcribe` | Audio file → text (Whisper) |
| `GET/POST /api/user/state` | Get or set tamagotchi state |
| `GET/POST /api/profile` | User profiles |
| `POST /api/profile/register` | Register a new user |
| `POST /api/seed` | Generate a new AI user profile |
| `POST /api/interview` | Run GPT-powered user interview |
| `POST /api/agents/date` | Trigger a date between agents |
| `GET /api/agents/activity` | Current agent activities |
| `GET /api/agents/conversations` | Date conversation history |
| `POST /api/scent/play` | Play scent recipe on device |
| `POST /api/scent/stop` | Stop scent playback |
| `POST /api/scent/recipe` | Generate scent recipe for a user |
| `GET /api/scent/status` | Device connection status |
| `POST /api/scent/connect` | Connect to BLE scent device |

## Tech stack

- **Next.js 16** with App Router and React 19
- **TypeScript**
- **Tailwind CSS 4**
- **OpenAI SDK** (GPT-4o, Whisper)
- **Python** for the BLE bridge and Pi client
- **Bleak** for BLE communication
- **Adafruit CircuitPython** libraries for the Pi display and LEDs

## License

This is a personal project, not licensed for distribution.
