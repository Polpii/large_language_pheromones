#!/usr/bin/env python3
"""
Raspberry Pi Tamagotchi Display Client
======================================
Renders the same pixel-art tamagotchi from the web app onto the
Seeed Studio 104990802 (ST7789 240x280) SPI screen.

Polls the Next.js server for state and updates the display.
Button press records audio via microphone, transcribes via the server
(Whisper), and sends the transcription to /api/listen.
LED strip shows a colour animation for each tamagotchi state.

Usage:
    python3 client.py --server http://192.168.1.XX:3000 --user elisa

Extra dependencies (install on Pi):
    pip3 install adafruit-circuitpython-rgb-display adafruit-circuitpython-neopixel
    pip3 install Pillow requests sounddevice numpy gpiozero
"""

import time
import math
import argparse
import sys
import threading
import colorsys
import os
import wave
import tempfile
import subprocess

import board
import digitalio
from PIL import Image, ImageDraw
import adafruit_rgb_display.st7789 as st7789
import neopixel
from gpiozero import Button

try:
    import requests
except ImportError:
    print("Install requests: pip3 install requests")
    sys.exit(1)

try:
    import sounddevice as sd
    import numpy as np
    _AUDIO_AVAILABLE = True
except ImportError:
    print("WARNING: sounddevice/numpy not found – button recording disabled.")
    print("         pip3 install sounddevice numpy")
    _AUDIO_AVAILABLE = False

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# ---------- Screen setup ----------
SCREEN_W, SCREEN_H = 240, 280

spi = board.SPI()
cs_pin = None
dc_pin = digitalio.DigitalInOut(board.D24)
rst_pin = digitalio.DigitalInOut(board.D25)

disp = st7789.ST7789(
    spi,
    cs=cs_pin,
    dc=dc_pin,
    rst=rst_pin,
    baudrate=62500000,  # Max SPI speed for smoother display
    width=SCREEN_W,
    height=SCREEN_H,
    rotation=0,
)

# ---------- LED strip setup ----------
NUM_PIXELS = 30
BUTTON_PIN = 26          # BCM numbering — same as led_strip_test.py
LED_DATA_PIN = board.D13  # GPIO13 physical pin 33

pixels = neopixel.NeoPixel(
    LED_DATA_PIN,
    NUM_PIXELS,
    brightness=0.25,
    auto_write=False,  # manual show() for batched updates
)


# ---------- LED animation functions (one per tamagotchi state) ----------

def _hsv(h, s=1.0, v=0.6):
    """Return (R,G,B) tuple 0-255 for the given HSV values."""
    r, g, b = colorsys.hsv_to_rgb(h % 1.0, s, v)
    return (int(r * 255), int(g * 255), int(b * 255))


def led_update(state, t):
    """Compute and write one LED frame for *state* at time *t* seconds."""
    if state == "idle":
        # Solid red, no animation.
        pixels.fill((180, 0, 0))

    elif state == "listen":
        # Cyan breathing — microphone is active.
        level = int(80 + abs(math.sin(t * 2.5)) * 175)
        pixels.fill((0, level // 4, level))

    elif state == "wave":
        # Rainbow travelling chase — joyful wave.
        offset = (t * 0.35) % 1.0
        for i in range(NUM_PIXELS):
            pixels[i] = _hsv((i / NUM_PIXELS + offset) % 1.0)

    elif state == "think":
        # Slow blue-purple breathing — processing.
        level = int(30 + abs(math.sin(t * 1.0)) * 150)
        b = level
        r = level // 5
        pixels.fill((r, 0, b))

    elif state == "dating":
        # Pink/red heartbeat pattern — love!
        BEAT = (0.08, 0.35, 0.14, 0.40, 0.10, 0.10, 0.10, 0.10)
        level = BEAT[int(t * 5) % len(BEAT)]
        pixels.fill((int(255 * level), int(20 * level), int(80 * level)))

    elif state == "interact":
        # Fast warm orange/yellow spark chase.
        COLORS = [(255, 80, 0), (255, 180, 0), (200, 40, 0)]
        offset = int(t * 15) % NUM_PIXELS
        pixels.fill((0, 0, 0))
        for i in range(NUM_PIXELS):
            if (i + offset) % 5 in (0, 1):
                pixels[i] = COLORS[(i + offset) % len(COLORS)]

    else:
        pixels.fill((0, 0, 0))

    pixels.show()


# ---------- Tamagotchi data (mirrored from Tamagotchi.tsx) ----------

SHAPES = [
    # 0 — Classic
    [
        "      GG      ",
        "      gg      ",
        "    CCCCCC    ",
        "   CCCCCCCC   ",
        "  CCCCCCCCCC  ",
        "  WWWcCCcWWW  ",
        "  WKKcCCcKKW  ",
        "  WWWcCCcWWW  ",
        " ACPCCCCCPCA  ",
        " ACCCCMMCCCA  ",
        "  CCCCCCCCCC  ",
        "  CChCCCChCC  ",
        "   CCCCCCCC   ",
        "    CCCCCC    ",
        "     CCCC     ",
        "              ",
        "   DD    DD   ",
    ],
    # 1 — Cat
    [
        " GG        GG ",
        "  CG      GC  ",
        "   CCCCCCCC   ",
        "  CCCCCCCCCC  ",
        "  CCCCCCCCCC  ",
        "  WWWcCCcWWW  ",
        "  WKKcCCcKKW  ",
        "  WWWcCCcWWW  ",
        "  CCPCCCCCPC  ",
        "  CCCCMMCCCC  ",
        "  CCCCCCCCCC  ",
        "   CChCChCC   ",
        "    CCCCCC    ",
        "     CCCC     ",
        "              ",
        "   DD    DD   ",
        "              ",
    ],
    # 2 — Ghost
    [
        "              ",
        "    CCCCCC    ",
        "   CCCCCCCC   ",
        "  CCCCCCCCCC  ",
        "  CCCCCCCCCC  ",
        "  WWWcCCcWWW  ",
        "  WKKcCCcKKW  ",
        "  WWWcCCcWWW  ",
        "  CCCCCCCCCC  ",
        "  CCCCMMCCCC  ",
        "  CCCCCCCCCC  ",
        "  CCCCCCCCCC  ",
        "  CCCCCCCCCC  ",
        "  CChCCCChCC  ",
        " CC CC  CC CC ",
        "  C  C  C  C  ",
        "              ",
    ],
    # 3 — Robot
    [
        "     GGGG     ",
        "      gg      ",
        "  CCCCCCCCCC  ",
        "  CCCCCCCCCC  ",
        "  CCCCCCCCCC  ",
        "  CWWWccWWWC  ",
        "  CWKKccKKWC  ",
        "  CWWWccWWWC  ",
        "  CCCCCCCCCC  ",
        "  CCCCMMCCCC  ",
        " ACCCCCCCCCA  ",
        " ACCCCCCCCCA  ",
        "  CChCCCChCC  ",
        "  CCCCCCCCCC  ",
        "  CCCCCCCCCC  ",
        "  DDDD  DDDD  ",
        "              ",
    ],
    # 4 — Bear
    [
        "  CC      CC  ",
        " CCCC    CCCC ",
        "  CCCCCCCCCC  ",
        "  CCCCCCCCCC  ",
        "  CCCCCCCCCC  ",
        "  WWWcCCcWWW  ",
        "  WKKcCCcKKW  ",
        "  WWWcCCcWWW  ",
        "  CCPCCCCCPC  ",
        "   CCCMMCCC   ",
        "  CCCCCCCCCC  ",
        "  CChCCCChCC  ",
        "   CCCCCCCC   ",
        "    CCCCCC    ",
        "     CCCC     ",
        "   DD    DD   ",
        "              ",
    ],
    # 5 — Bunny
    [
        "   CC    CC   ",
        "   CC    CC   ",
        "   CC    CC   ",
        "   CCCCCCCC   ",
        "  CCCCCCCCCC  ",
        "  WWWcCCcWWW  ",
        "  WKKcCCcKKW  ",
        "  WWWcCCcWWW  ",
        "  PPCCCCCCPP  ",
        "   CCCMMCCC   ",
        "  CCCCCCCCCC  ",
        "  CChCCCChCC  ",
        "   CCCCCCCC   ",
        "    CCCCCC    ",
        "     CCCC     ",
        "   DD    DD   ",
        "              ",
    ],
    # 6 — Alien
    [
        "      GG      ",
        "   GGGGGGGG   ",
        "  GGGGGGGGGG  ",
        " CCCCCCCCCCCC ",
        " CCCCCCCCCCCC ",
        " CWWWcCCcWWWC ",
        " CWKKcCCcKKWC ",
        " CWWWcCCcWWWC ",
        "  CCCCCCCCCC  ",
        "  CCCCMMCCCC  ",
        "   CCCCCCCC   ",
        "    CCCCCC    ",
        "    CChChC    ",
        "     CCCC     ",
        "      CC      ",
        "    DD  DD    ",
        "              ",
    ],
    # 7 — Penguin
    [
        "              ",
        "    CCCCCC    ",
        "   CCCCCCCC   ",
        "  CCCCCCCCCC  ",
        "  CCCCCCCCCC  ",
        "  WWWcCCcWWW  ",
        "  WKKcCCcKKW  ",
        "  WWWcCCcWWW  ",
        "AACCCCCCCCAA  ",
        "AACCCCMMCCAA  ",
        " AChCCCCChCA  ",
        " AChCCCCChCA  ",
        "  ChhCCChhC   ",
        "   CCCCCCCC   ",
        "    CCCCCC    ",
        "   DDD  DDD   ",
        "              ",
    ],
    # 8 — Mushroom
    [
        "   GGGGGGGG   ",
        "  GGGGGGGGGG  ",
        " GGGGGGGGGGGG ",
        " GGhGGGGGGhGG ",
        " GGGGGGGGGGGG ",
        "  CCCCCCCCCC  ",
        "  WWWcCCcWWW  ",
        "  WKKcCCcKKW  ",
        "  WWWcCCcWWW  ",
        "   CCCCCCCC   ",
        "    CCMMCC    ",
        "    CCCCCC    ",
        "    CCCCCC    ",
        "    CChChC    ",
        "    CCCCCC    ",
        "   DDDDDDDD   ",
        "              ",
    ],
    # 9 — Octopus
    [
        "              ",
        "    CCCCCC    ",
        "   CCCCCCCC   ",
        "  CCCCCCCCCC  ",
        "  CCCCCCCCCC  ",
        "  WWWcCCcWWW  ",
        "  WKKcCCcKKW  ",
        "  WWWcCCcWWW  ",
        "  CCPCCCCCPC  ",
        "  CCCCMMCCCC  ",
        "  CCCCCCCCCC  ",
        " CCCCCCCCCCCC ",
        " DC DC DC DC  ",
        "  D  D  D  D  ",
        " DC DC DC DC  ",
        "  D  D  D  D  ",
        "              ",
    ],
]

PALETTES = [
    {"G": "#FFD700", "g": "#FFA000", "C": "#00E5FF", "c": "#B2EBF2", "h": "#4DD0E1", "W": "#FFFFFF", "K": "#1A1A2E", "P": "#FF69B4", "M": "#FF4081", "A": "#00BCD4", "D": "#00838F"},
    {"G": "#FF6B6B", "g": "#EE5A24", "C": "#FF6348", "c": "#FFB8B8", "h": "#FF4757", "W": "#FFFFFF", "K": "#1A1A2E", "P": "#FFDD59", "M": "#FFC312", "A": "#FF3838", "D": "#C44569"},
    {"G": "#A3CB38", "g": "#009432", "C": "#6AB04C", "c": "#BADC58", "h": "#7BED9F", "W": "#FFFFFF", "K": "#1A1A2E", "P": "#E056A0", "M": "#D63031", "A": "#2ECC71", "D": "#1B9CFC"},
    {"G": "#E056A0", "g": "#B83280", "C": "#D980FA", "c": "#E8AFFF", "h": "#C56CF0", "W": "#FFFFFF", "K": "#1A1A2E", "P": "#FF69B4", "M": "#FDA7DF", "A": "#BE2EDD", "D": "#6C5CE7"},
    {"G": "#FFC312", "g": "#F79F1F", "C": "#F39C12", "c": "#FFE0A0", "h": "#FDCB6E", "W": "#FFFFFF", "K": "#1A1A2E", "P": "#E17055", "M": "#D63031", "A": "#E67E22", "D": "#D35400"},
    {"G": "#1B9CFC", "g": "#0652DD", "C": "#3742FA", "c": "#A4B0F5", "h": "#70A1FF", "W": "#FFFFFF", "K": "#1A1A2E", "P": "#7BED9F", "M": "#2ED573", "A": "#1E90FF", "D": "#3742FA"},
    {"G": "#FDA7DF", "g": "#D63031", "C": "#FD79A8", "c": "#FFCCCC", "h": "#FF6B81", "W": "#FFFFFF", "K": "#1A1A2E", "P": "#E84393", "M": "#FF4081", "A": "#E84393", "D": "#B53471"},
    {"G": "#55E6C1", "g": "#58B19F", "C": "#00D2D3", "c": "#AAFFEE", "h": "#7EFACC", "W": "#FFFFFF", "K": "#1A1A2E", "P": "#FECA57", "M": "#FF9FF3", "A": "#48DBFB", "D": "#01A3A4"},
    {"G": "#FF9F43", "g": "#EE5A24", "C": "#FFA502", "c": "#FFD8A8", "h": "#FECA57", "W": "#FFFFFF", "K": "#1A1A2E", "P": "#FF6348", "M": "#EE5A24", "A": "#E67E22", "D": "#CC8E35"},
    {"G": "#C4E538", "g": "#A3CB38", "C": "#7BED9F", "c": "#DFFFD6", "h": "#55E6C1", "W": "#FFFFFF", "K": "#1A1A2E", "P": "#FECA57", "M": "#BADC58", "A": "#33D9B2", "D": "#218C74"},
]


def hex_to_rgb(h):
    """Convert '#RRGGBB' to (R, G, B) tuple."""
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def hash_str(s):
    """Same hash as the JS hashStr function."""
    h = 0
    for ch in s:
        h = ((h << 5) - h + ord(ch)) & 0xFFFFFFFF
        if h >= 0x80000000:
            h -= 0x100000000
    return abs(h)


def get_shape_and_palette(user_id):
    """Pick shape and palette based on userId hash (matches the web app)."""
    h = hash_str(user_id)
    palette_idx = h % len(PALETTES)
    shape_idx = (h // len(SHAPES)) % len(SHAPES)
    palette = {k: hex_to_rgb(v) for k, v in PALETTES[palette_idx].items()}
    shape = SHAPES[shape_idx]
    return shape, palette


# ---------- Rendering ----------

PIXEL_SIZE = 15  # Each pixel = 15x15 real pixels → 14*15=210 wide, 17*15=255 tall
GRID_W, GRID_H = 14, 17
TAMA_W = GRID_W * PIXEL_SIZE  # 210
TAMA_H = GRID_H * PIXEL_SIZE  # 255
OFFSET_X = (SCREEN_W - TAMA_W) // 2  # center horizontally
BASE_Y = (SCREEN_H - TAMA_H) // 2    # center vertically


def pre_render_sprites(shape, palette):
    """Pre-render the tamagotchi sprite (eyes open) and blink sprite (eyes closed).
    Returns two RGBA images that can be pasted onto the frame."""
    sprites = {}
    for blink_mode in (False, True):
        img = Image.new("RGBA", (TAMA_W, TAMA_H), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        for row_idx, row in enumerate(shape):
            for col_idx, char in enumerate(row):
                if char == " ":
                    continue
                if blink_mode and char in ("W", "K"):
                    char = "C"
                color = palette.get(char)
                if color is None:
                    continue
                x = col_idx * PIXEL_SIZE
                y = row_idx * PIXEL_SIZE
                draw.rectangle(
                    [x, y, x + PIXEL_SIZE - 1, y + PIXEL_SIZE - 1],
                    fill=color + (255,),
                )
        sprites[blink_mode] = img
    return sprites


def render_frame(sprites, palette, blink=False, y_offset=0, x_offset=0, rotation=0.0, state="idle", t=0.0):
    """Render one frame compositing pre-rendered sprite onto black background."""
    img = Image.new("RGB", (SCREEN_W, SCREEN_H), (0, 0, 0))
    draw = ImageDraw.Draw(img)

    ox = OFFSET_X + int(x_offset)
    oy = BASE_Y + int(y_offset)
    cx = ox + TAMA_W // 2
    cy = oy + TAMA_H // 2

    # Draw effects BEHIND the tamagotchi
    if state == "wave":
        pass  # Wave effect is just the bounce + rotation (like the web app)
    elif state == "dating":
        # 5 expanding ripple circles with pink tint
        pink = palette.get("P", (255, 105, 180))
        for i in range(5):
            phase = (t * 0.6 + i * 0.2) % 1.0
            r = int(30 + phase * 120)
            alpha = max(0, int(255 * (1.0 - phase)))
            color = tuple(min(255, c * alpha // 255) for c in pink)
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=color, width=2)
        # Floating diamond hearts
        for i in range(4):
            h_phase = (t * 0.4 + i * 0.25) % 1.0
            hx = cx + int(math.sin(t * 0.8 + i * 1.5) * 60)
            hy = int(cy + 60 - h_phase * 140)
            h_alpha = max(0, int(255 * (1.0 - abs(h_phase - 0.5) * 2)))
            h_color = tuple(min(255, c * h_alpha // 255) for c in pink)
            hs = 5
            draw.polygon([(hx, hy - hs), (hx + hs, hy), (hx, hy + hs), (hx - hs, hy)], fill=h_color)
    elif state == "interact":
        for i in range(2):
            phase = (t * 0.8 + i * 0.5) % 1.0
            r = int(30 + phase * 60)
            alpha = max(0, int(200 * (1.0 - phase)))
            color = tuple(min(255, c * alpha // 255) for c in palette.get("G", (255, 215, 0)))
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=color, width=2)
    elif state == "listen":
        # Double pulsing glow border, bright
        pulse = int(160 + abs(math.sin(t * 3.5)) * 95)
        glow_base = palette.get("C", (0, 200, 255))
        glow_color = tuple(min(255, c * pulse // 255) for c in glow_base)
        draw.rectangle(
            [ox - 10, oy - 10, ox + TAMA_W + 9, oy + TAMA_H + 9],
            outline=glow_color, width=3,
        )
        # Inner border
        inner_pulse = int(100 + abs(math.sin(t * 3.5 + 1.0)) * 100)
        inner_color = tuple(min(255, c * inner_pulse // 255) for c in glow_base)
        draw.rectangle(
            [ox - 4, oy - 4, ox + TAMA_W + 3, oy + TAMA_H + 3],
            outline=inner_color, width=2,
        )
        # Sound wave bars on left
        for i in range(4):
            bar_h = int(8 + abs(math.sin(t * 5.0 + i * 0.8)) * 18)
            bar_y = cy - bar_h // 2
            bar_x = ox - 18 - i * 6
            bar_bright = int(150 + abs(math.sin(t * 4.0 + i)) * 105)
            bar_color = tuple(min(255, c * bar_bright // 255) for c in glow_base)
            draw.rectangle([bar_x, bar_y, bar_x + 3, bar_y + bar_h], fill=bar_color)
        # Sound wave bars on right
        for i in range(4):
            bar_h = int(8 + abs(math.sin(t * 5.0 + i * 0.8 + 2.0)) * 18)
            bar_y = cy - bar_h // 2
            bar_x = ox + TAMA_W + 14 + i * 6
            bar_bright = int(150 + abs(math.sin(t * 4.0 + i + 2.0)) * 105)
            bar_color = tuple(min(255, c * bar_bright // 255) for c in glow_base)
            draw.rectangle([bar_x, bar_y, bar_x + 3, bar_y + bar_h], fill=bar_color)
    elif state == "think":
        dots_y = oy + TAMA_H + 12
        dot_phase = int(t * 3) % 3
        for i in range(3):
            dx = cx - 12 + i * 12
            brightness = 200 if i == dot_phase else 60
            dot_color = tuple(min(255, c * brightness // 255) for c in palette.get("C", (0, 200, 255)))
            draw.ellipse([dx - 3, dots_y - 3, dx + 3, dots_y + 3], fill=dot_color)

    # Paste pre-rendered sprite (with optional rotation)
    sprite = sprites[blink]
    if rotation != 0.0:
        rotated = sprite.rotate(rotation, resample=Image.BICUBIC, expand=True)
        # Center the rotated sprite at the same position
        rw, rh = rotated.size
        rx = ox + TAMA_W // 2 - rw // 2
        ry = oy + TAMA_H // 2 - rh // 2
        img.paste(rotated, (rx, ry), rotated)
    else:
        img.paste(sprite, (ox, oy), sprite)

    return img


# ---------- Audio recording + transcription ----------

SAMPLE_RATE = 16000   # Hz — Whisper prefers 16 kHz
MAX_RECORD_SECS = 10  # Maximum hold-to-record duration

# Shared containers updated by button callbacks and the recording thread
_record_stop = threading.Event()
_record_stop.set()  # starts in "not recording" state
_override = {"state": None}  # local state override (None = use server state)
_override_lock = threading.Lock()


def _set_override(s):
    with _override_lock:
        _override["state"] = s


def _clear_override():
    with _override_lock:
        _override["state"] = None


# ---------- Art display mode -----------

_ART_DURATION = 30  # seconds to display art.png

def _show_art(disp, server_url, user_id):
    """Load art.png and display it centered on screen for _ART_DURATION seconds, then return."""
    art_path = os.path.join(_SCRIPT_DIR, "art.png")
    if not os.path.isfile(art_path):
        print(f"[art] art.png not found at {art_path}")
        return

    try:
        art_img = Image.open(art_path).convert("RGB")
    except Exception as e:
        print(f"[art] Failed to load art.png: {e}")
        return

    # Scale to fit ~90% of screen height, maintain aspect ratio
    target_h = int(SCREEN_H * 1.8)
    target_w = int(SCREEN_W * 1.8)
    art_w, art_h = art_img.size
    scale = min(target_w / art_w, target_h / art_h)
    new_w = int(art_w * scale)
    new_h = int(art_h * scale)
    art_img = art_img.resize((new_w, new_h), Image.LANCZOS)

    # Center on black background
    canvas = Image.new("RGB", (SCREEN_W, SCREEN_H), (0, 0, 0))
    paste_x = (SCREEN_W - new_w) // 2
    paste_y = (SCREEN_H - new_h) // 2
    canvas.paste(art_img, (paste_x, paste_y))

    disp.image(canvas)
    print(f"[art] Displaying art.png for {_ART_DURATION}s")

    # Wait, then tell the server we're back to idle
    time.sleep(_ART_DURATION)

    try:
        requests.post(f"{server_url}/api/user/state",
                       json={"deviceId": user_id, "state": "idle"}, timeout=2)
    except Exception:
        pass
    print("[art] Done, returning to idle")


# ---------- Sound playback helpers ----------

_loop_stop = threading.Event()  # signal the loop thread to stop
_loop_proc = None               # current subprocess.Popen being played
_loop_lock = threading.Lock()


def _play_mp3(filename):
    """Play an MP3 file once (fire-and-forget in a thread, non-blocking)."""
    filepath = os.path.join(_SCRIPT_DIR, filename)
    if not os.path.isfile(filepath):
        return
    def _run():
        try:
            subprocess.run(["mpg123", filepath],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except FileNotFoundError:
            try:
                subprocess.run(["ffplay", "-nodisp", "-autoexit", filepath],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception:
                pass
    threading.Thread(target=_run, daemon=True).start()


def _play_mp3_loop(filename):
    """Start looping an MP3 file in the background. Call _stop_loop() to end."""
    global _loop_proc
    _stop_loop()  # stop any previous loop first
    filepath = os.path.join(_SCRIPT_DIR, filename)
    if not os.path.isfile(filepath):
        return
    _loop_stop.clear()
    def _run():
        global _loop_proc
        while not _loop_stop.is_set():
            try:
                proc = subprocess.Popen(["mpg123", filepath],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except FileNotFoundError:
                try:
                    proc = subprocess.Popen(["ffplay", "-nodisp", "-autoexit", filepath],
                                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                except Exception:
                    break
            except Exception:
                break
            with _loop_lock:
                _loop_proc = proc
            proc.wait()
            with _loop_lock:
                _loop_proc = None
    threading.Thread(target=_run, daemon=True).start()


def _stop_loop():
    """Stop a looping sound — kills the running process immediately."""
    global _loop_proc
    _loop_stop.set()
    with _loop_lock:
        if _loop_proc is not None:
            try:
                _loop_proc.kill()
            except Exception:
                pass
            _loop_proc = None


_HEARTBEAT_FILES = ["heartbeat05.mp3", "heartbeat1.mp3", "heartbeat15.mp3"]


def _play_heartbeat_sequence():
    """Play the three heartbeat MP3 files in order, waiting for each to finish."""
    _stop_loop()  # Kill the dating.mp3 loop FIRST
    for filename in _HEARTBEAT_FILES:
        filepath = os.path.join(_SCRIPT_DIR, filename)
        if not os.path.isfile(filepath):
            print(f"[audio] Missing: {filepath}")
            continue
        print(f"[audio] Playing {filename}")
        try:
            subprocess.run(["mpg123", filepath], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except FileNotFoundError:
            # mpg123 not installed, try aplay with ffmpeg pipe as fallback
            try:
                subprocess.run(["ffplay", "-nodisp", "-autoexit", filepath],
                               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception as e:
                print(f"[audio] Playback failed for {filename}: {e}")
                break
        except Exception as e:
            print(f"[audio] Playback failed for {filename}: {e}")
            break
    print("[audio] Heartbeat sequence done")


def _do_recording(server_url, user_id):
    """Record audio while the button is held, then transcribe + process."""
    if not _AUDIO_AVAILABLE:
        return

    print("[mic] Recording started")
    chunks = []

    try:
        with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="int16") as stream:
            while not _record_stop.is_set():
                chunk, _ = stream.read(1024)
                chunks.append(chunk.copy())
                if len(chunks) * 1024 / SAMPLE_RATE >= MAX_RECORD_SECS:
                    break
    except Exception as e:
        print(f"[mic] Recording error: {e}")
        _clear_override()
        return

    if not chunks:
        _clear_override()
        return

    audio_data = np.concatenate(chunks, axis=0)
    print(f"[mic] Recorded {len(audio_data) / SAMPLE_RATE:.1f}s")

    # Switch to "think" (purple breathing) while the server transcribes
    _set_override("think")

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            tmp_path = f.name
        with wave.open(tmp_path, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)  # int16 = 2 bytes
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(audio_data.tobytes())

        # POST audio to /api/transcribe — server runs Whisper and returns text
        with open(tmp_path, "rb") as f:
            resp = requests.post(
                f"{server_url}/api/transcribe",
                files={"audio": ("audio.wav", f, "audio/wav")},
                timeout=30,
            )
        resp.raise_for_status()
        text = resp.json().get("text", "").strip()
    except Exception as e:
        print(f"[mic] Transcription error: {e}")
        _clear_override()
        return
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    if not text:
        print("[mic] Empty transcription")
        _clear_override()
        return

    print(f"[mic] Transcribed: {text}")

    # POST the transcription text to /api/listen — same flow as pressing L in browser
    try:
        resp = requests.post(
            f"{server_url}/api/listen",
            json={"deviceId": user_id, "text": text},
            timeout=10,
        )
        data = resp.json()
        action = data.get("action")
        print(f"[mic] Listen response: {action} — {data.get('message', '')}")

        if action == "dating":
            # /api/listen detected a dating intent — kick off the dating round
            query = data.get("query", text)
            _set_override("dating")
            print(f"[mic] Starting dating: {query}")
            try:
                date_resp = requests.post(
                    f"{server_url}/api/agents/date",
                    json={"deviceId": user_id, "query": query},
                    timeout=120,  # dating can take a while (multiple LLM calls)
                )
                date_data = date_resp.json()
                summary = date_data.get("summary", "")
                matches = date_data.get("matches", [])
                print(f"[mic] Dating done — {summary}")
                if matches:
                    best = matches[0]
                    print(f"[mic] Best match: {best.get('profileId')} (score {best.get('score')})")
                    # Play heartbeat MP3 sequence (scent is already triggered server-side)
                    _play_heartbeat_sequence()
            except Exception as e:
                print(f"[mic] Dating error: {e}")
    except Exception as e:
        print(f"[mic] Listen error: {e}")

    # Release the override so the server-polled state takes over
    _clear_override()


def main():
    parser = argparse.ArgumentParser(description="Tamagotchi display for Raspberry Pi")
    parser.add_argument("--server", required=True, help="Next.js server URL, e.g. http://192.168.1.10:3000")
    parser.add_argument("--user", required=True, help="User ID, e.g. elisa")
    parser.add_argument("--fps", type=int, default=25, help="Target FPS (default: 15)")
    args = parser.parse_args()

    server = args.server.rstrip("/")
    user_id = args.user
    fps = args.fps
    frame_time = 1.0 / fps

    shape, palette = get_shape_and_palette(user_id)
    sprites = pre_render_sprites(shape, palette)
    print(f"Tamagotchi for '{user_id}' — shape {SHAPES.index(shape)}, palette {hash_str(user_id) % len(PALETTES)}")
    print(f"Server: {server}")
    print(f"Screen: {SCREEN_W}x{SCREEN_H}, FPS target: {fps}")

    # Shared state (updated by poller thread)
    state = "idle"
    state_lock = threading.Lock()

    # Background thread polls server every 0.5s
    def poller():
        nonlocal state
        session = requests.Session()
        while True:
            try:
                resp = session.get(
                    f"{server}/api/user/state",
                    params={"deviceId": user_id},
                    timeout=2,
                )
                if resp.status_code == 200:
                    new_state = resp.json().get("state", "idle")
                    with state_lock:
                        if new_state != state:
                            print(f"State: {state} → {new_state}")
                            state = new_state
            except Exception:
                pass
            time.sleep(0.5)

    poll_thread = threading.Thread(target=poller, daemon=True)
    poll_thread.start()

    # ---------- Button: hold to record ----------
    button = Button(BUTTON_PIN, pull_up=True, bounce_time=0.05)

    def _on_press():
        """Button pressed: start recording and override state to 'listen'."""
        if not _AUDIO_AVAILABLE:
            return
        _play_mp3("listen.mp3")
        _set_override("listen")
        _record_stop.clear()
        threading.Thread(
            target=_do_recording,
            args=(server, user_id),
            daemon=True,
        ).start()

    def _on_release():
        """Button released: signal recording thread to stop."""
        _record_stop.set()

    button.when_pressed = _on_press
    button.when_released = _on_release

    blink = False
    blink_timer = time.time() + 3.0
    prev_state = "idle"  # track state transitions for sound triggers

    # Show initial frame
    img = render_frame(sprites, palette, blink=False, y_offset=0, x_offset=0, state="idle", t=time.time())
    disp.image(img)
    print("Display initialized. Hold button to speak. Polling for state...")

    try:
        while True:
            t0 = time.time()

            # Blink logic
            if t0 >= blink_timer:
                blink = True
                blink_timer = t0 + 2.5 + (hash_str(user_id + str(int(t0))) % 2000) / 1000.0
            if blink and t0 >= blink_timer - 2.3:
                blink = False

            # Local override (recording/processing) takes priority over server state
            with state_lock:
                cur_state = state
            with _override_lock:
                if _override["state"]:
                    cur_state = _override["state"]

            # Sound triggers on state transitions
            if cur_state != prev_state:
                if cur_state == "wave":
                    _play_mp3("wave.mp3")
                elif cur_state == "dating":
                    _play_mp3_loop("dating.mp3")
                # Stop dating loop when leaving dating state
                if prev_state == "dating" and cur_state != "dating":
                    _stop_loop()
                prev_state = cur_state

            # Update LED strip
            led_update(cur_state, t0)

            # Art mode: display art.png for 30s then revert to idle
            if cur_state == "art":
                _show_art(disp, server, user_id)
                with state_lock:
                    state = "idle"
                prev_state = "idle"
                continue

            # Animation offsets
            x_off = 0
            rot = 0.0
            if cur_state == "idle":
                y_off = math.sin(t0 * 1.2) * 8
            elif cur_state == "wave":
                # Match CSS: wave-bounce 0.5s — bounce up 16px + tilt ±10°
                cycle = (t0 % 0.5) / 0.5  # 0..1 over 0.5s
                if cycle < 0.25:
                    p = cycle / 0.25
                    y_off = -16 * p
                    rot = -10 * p
                elif cycle < 0.75:
                    p = (cycle - 0.25) / 0.5
                    y_off = -16
                    rot = -10 + 20 * p
                else:
                    p = (cycle - 0.75) / 0.25
                    y_off = -16 * (1 - p)
                    rot = 10 * (1 - p)
            elif cur_state == "listen":
                y_off = math.sin(t0 * 2.0) * 3
            elif cur_state == "think":
                y_off = math.sin(t0 * 0.8) * 6
            elif cur_state == "dating":
                y_off = math.sin(t0 * 0.8) * 4
            elif cur_state == "interact":
                y_off = abs(math.sin(t0 * 3.0)) * -10
            else:
                y_off = 0

            # Render and display
            img = render_frame(sprites, palette, blink=blink, y_offset=y_off, x_offset=x_off, rotation=rot, state=cur_state, t=t0)
            disp.image(img)

            # Frame rate control
            elapsed = time.time() - t0
            sleep_time = frame_time - elapsed
            if sleep_time > 0:
                time.sleep(sleep_time)
    finally:
        _stop_loop()
        pixels.fill((0, 0, 0))
        pixels.show()


if __name__ == "__main__":
    main()
