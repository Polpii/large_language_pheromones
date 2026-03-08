#!/usr/bin/env python3
"""
Scent BLE Bridge — Lightweight HTTP server for communicating with the
scent device via BLE.

Auto-started by the Next.js app. Listens on port 5050.

Usage:
    python server.py [--port 5050]
"""

import asyncio
import json
import sys
import os
import argparse
import threading
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

# Force UTF-8 output on Windows to avoid charmap encoding errors
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

try:
    from bleak import BleakClient, BleakScanner
    HAS_BLEAK = True
except ImportError:
    HAS_BLEAK = False
    print("[scent-bridge] WARNING: bleak not installed -- BLE disabled, running in mock mode")


# ---------- BLE configuration ----------
DEVICE_NAME_KEYWORD = "wear"
WRITE_CHAR_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"

# Shared state
_cached_device_address = None
_is_playing = False
_stop_event = None       # asyncio.Event set when stop is requested
_active_client = None    # BleakClient while playing (for sending stop on same connection)
_active_scent_ids = []   # scent IDs that have been sent (for targeted stop)
_device_connected = False
_device_address_str = ""
_last_play_error = ""
_play_future = None      # asyncio Future for cancellation

# Dedicated asyncio event loop running in its own thread (required for bleak on Windows)
_loop = None
_loop_thread = None


def _start_async_loop():
    """Start a dedicated asyncio event loop in a background thread."""
    global _loop, _loop_thread
    _loop = asyncio.new_event_loop()

    def run():
        asyncio.set_event_loop(_loop)
        _loop.run_forever()

    _loop_thread = threading.Thread(target=run, daemon=True)
    _loop_thread.start()


def _run_async(coro, timeout=30):
    """Run an async coroutine on the dedicated loop and return the result (blocking)."""
    if _loop is None:
        _start_async_loop()
    future = asyncio.run_coroutine_threadsafe(coro, _loop)
    return future.result(timeout=timeout)


# ---------- BLE functions ----------

async def find_device(keyword=DEVICE_NAME_KEYWORD, timeout=10.0):
    """Scan for the BLE device. Returns the address or None.
    Does NOT open a connection — just discovers."""
    global _cached_device_address, _device_address_str
    if not HAS_BLEAK:
        return None

    # If we have a cached address, return it directly (no connection verify)
    if _cached_device_address:
        return _cached_device_address

    devices = await BleakScanner.discover(timeout=timeout)
    for d in devices:
        if d.name and keyword.lower() in d.name.lower():
            _cached_device_address = d.address
            _device_address_str = str(d.address)
            print(f"[scent-bridge] Found device: {d.name} ({d.address})")
            return d.address

    return None


def crc16_modbus(data: bytes) -> bytes:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return bytes([(crc >> 8) & 0xFF, crc & 0xFF])


def build_command(scent_id: int, duration_sec: int) -> bytes:
    start = bytes([0xF5])
    header = bytes([0x00, 0x00, 0x00, 0x01])
    cmd_type = bytes([0x02])
    subcmd = bytes([0x05])
    channel = bytes([scent_id])
    padding = bytes([0x00, 0x00])
    duration_ms = duration_sec * 1000
    duration_bytes = duration_ms.to_bytes(2, "big")
    body = header + cmd_type + subcmd + channel + padding + duration_bytes
    crc_bytes = crc16_modbus(body)
    end = bytes([0x55])
    return start + body + crc_bytes + end


def build_command_ms(scent_id: int, duration_ms: int) -> bytes:
    """Build a BLE command with duration in milliseconds (for precise control)."""
    start = bytes([0xF5])
    header = bytes([0x00, 0x00, 0x00, 0x01])
    cmd_type = bytes([0x02])
    subcmd = bytes([0x05])
    channel = bytes([scent_id])
    padding = bytes([0x00, 0x00])
    duration_bytes = max(1, duration_ms).to_bytes(2, "big")  # minimum 1ms, never 0
    body = header + cmd_type + subcmd + channel + padding + duration_bytes
    crc_bytes = crc16_modbus(body)
    end = bytes([0x55])
    return start + body + crc_bytes + end


async def _send_stop_all(client, used_scent_ids):
    """Send 1ms override to all 12 channels on an existing BLE connection to stop any active scent."""
    for ch in range(1, 13):
        try:
            stop_cmd = build_command_ms(ch, 1)
            await client.write_gatt_char(WRITE_CHAR_UUID, stop_cmd)
        except Exception as e:
            print(f"[scent-bridge] Failed to stop channel {ch}: {e}")


async def play_sequence_ble(sequence):
    """Play a scent sequence on the BLE device.
    Checks _stop_event between scents and during sleep.
    On stop: sends 1ms commands on the SAME connection to override active scents."""
    global _is_playing, _device_connected, _last_play_error, _active_client, _active_scent_ids, _stop_event
    if not HAS_BLEAK:
        _last_play_error = "bleak not installed"
        return
    _is_playing = True
    _last_play_error = ""
    _active_scent_ids = []
    _stop_event = asyncio.Event()
    try:
        addr = await find_device()
        if not addr:
            _last_play_error = "Scent device not found"
            print(f"[scent-bridge] ERROR: {_last_play_error}")
            return

        print(f"[scent-bridge] Connecting to {addr}...")
        async with BleakClient(addr, timeout=10.0) as client:
            if not client.is_connected:
                _device_connected = False
                _last_play_error = "Failed to connect to device"
                print(f"[scent-bridge] ERROR: {_last_play_error}")
                return

            _active_client = client
            _device_connected = True
            print(f"[scent-bridge] Connected! Playing {len(sequence)} scents...")

            for i, item in enumerate(sequence):
                if _stop_event.is_set():
                    break
                sid = item.get("scent_id", 1)
                dur = item.get("duration", 5)
                cmd = build_command(sid, dur)
                print(f"[scent-bridge] [{i+1}/{len(sequence)}] Scent {sid} for {dur}s -> {cmd.hex().upper()}")
                await client.write_gatt_char(WRITE_CHAR_UUID, cmd)
                _active_scent_ids.append(sid)

                # Sleep in 0.3s increments so stop is responsive
                elapsed = 0.0
                while elapsed < dur and not _stop_event.is_set():
                    await asyncio.sleep(min(0.3, dur - elapsed))
                    elapsed += 0.3

            if _stop_event.is_set():
                # Send 1ms stop to all channels that were activated, on the SAME connection
                print("[scent-bridge] Stop requested -- sending 1ms override on same connection...")
                await _send_stop_all(client, _active_scent_ids)
                print("[scent-bridge] Stop commands sent on same BLE connection")
            else:
                # Sequence finished normally -- send stop to all used channels to cut off the device
                print("[scent-bridge] Sequence completed -- sending cleanup stop to all channels...")
                await _send_stop_all(client, _active_scent_ids)
                print("[scent-bridge] Sequence completed successfully")
    except asyncio.CancelledError:
        print("[scent-bridge] Play task cancelled")
        _last_play_error = "Stopped by user"
    except Exception as e:
        _device_connected = False
        _last_play_error = str(e)
        print(f"[scent-bridge] ERROR during play: {e}")
        traceback.print_exc()
    finally:
        _is_playing = False
        _active_client = None
        _active_scent_ids = []
        _stop_event = None


async def test_connection():
    """Scan for device and verify BLE connection. Use sparingly (slow)."""
    global _device_connected, _device_address_str, _cached_device_address
    if not HAS_BLEAK:
        return {"connected": False, "message": "bleak not installed -- pip install bleak"}

    # Force a fresh scan (clear cache to rescan)
    _cached_device_address = None
    addr = await find_device()
    if not addr:
        _device_connected = False
        return {"connected": False, "message": "Device not found -- make sure it's powered on"}
    try:
        async with BleakClient(addr, timeout=5.0) as client:
            if client.is_connected:
                _device_connected = True
                _device_address_str = str(addr)
                return {"connected": True, "address": str(addr)}
    except Exception as e:
        _cached_device_address = None
        _device_connected = False
        return {"connected": False, "message": str(e)}
    return {"connected": False, "message": "Could not connect"}


# ---------- HTTP Server ----------

class Handler(BaseHTTPRequestHandler):
    def _send_json(self, data, code=200):
        try:
            body = json.dumps(data).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass  # Client disconnected, ignore

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            # Fast -- no BLE call, just return cached state
            self._send_json({
                "status": "ok",
                "playing": _is_playing,
                "device_connected": _device_connected,
                "device_address": _device_address_str,
                "bleak_installed": HAS_BLEAK,
                "last_error": _last_play_error,
            })
        elif self.path == "/connect":
            # Slow — triggers BLE scan
            try:
                result = _run_async(test_connection())
                self._send_json(result)
            except Exception as e:
                self._send_json({"connected": False, "message": str(e)})
        else:
            self._send_json({"error": "Not found"}, 404)

    def do_POST(self):
        if self.path == "/stop":
            if _is_playing and _stop_event is not None and _loop is not None:
                # Thread-safe: set the asyncio.Event from the HTTP thread
                _loop.call_soon_threadsafe(_stop_event.set)
                # Wait briefly for the play coroutine to finish its stop sequence
                import time
                for _ in range(30):  # wait up to 3s
                    if not _is_playing:
                        break
                    time.sleep(0.1)
                self._send_json({"status": "stopped", "message": "Stop signal sent on same BLE connection"})
            else:
                self._send_json({"status": "ok", "message": "Nothing playing"})
            return
        if self.path == "/play":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                data = json.loads(body)
                sequence = data.get("sequence", [])
                if not sequence:
                    self._send_json({"status": "error", "message": "No sequence"}, 400)
                    return
                if _is_playing:
                    self._send_json({"status": "error", "message": "Already playing"}, 409)
                    return
                # Start play in background on the async loop -- return immediately
                _play_future = asyncio.run_coroutine_threadsafe(play_sequence_ble(sequence), _loop)
                total_dur = sum(item.get("duration", 5) for item in sequence)
                self._send_json({
                    "status": "playing",
                    "message": f"Playing {len(sequence)} scents ({total_dur}s)",
                    "total_duration": total_dur,
                })
            except json.JSONDecodeError:
                self._send_json({"status": "error", "message": "Invalid JSON"}, 400)
            except Exception as e:
                self._send_json({"status": "error", "message": str(e)}, 500)
        else:
            self._send_json({"error": "Not found"}, 404)

    def log_message(self, fmt, *args):
        print(f"[scent-bridge] {fmt % args}")


def main():
    parser = argparse.ArgumentParser(description="Scent BLE Bridge")
    parser.add_argument("--port", type=int, default=5050)
    args = parser.parse_args()

    # Start the async event loop thread for bleak
    _start_async_loop()

    class ThreadedServer(ThreadingMixIn, HTTPServer):
        daemon_threads = True

    server = ThreadedServer(("0.0.0.0", args.port), Handler)
    print(f"[scent-bridge] Listening on port {args.port}")
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[scent-bridge] Shutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
