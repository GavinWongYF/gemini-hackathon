#!/usr/bin/env python3
"""
Zero-Click Wireless BLE -> WebSocket Bridge for M5-TENNIS-IMU.

Auto-discovers M5-TENNIS-IMU over macOS CoreBluetooth (via bleak), subscribes to
its 13-byte binary 100 Hz IMU GATT notifications, and forwards compact CSV packets
directly to the Vite dev server relay (ws://localhost:5173/ws-hardware).

Works in EVERY browser (Chrome, Safari, Arc, Firefox) with zero pairing popups.
"""

import asyncio
import struct
import time
import websockets
from bleak import BleakClient, BleakScanner

SERVICE_UUID = "19b10000-e8f2-537e-4f6c-d104768a1214"
IMU_CHAR_UUID = "19b10001-e8f2-537e-4f6c-d104768a1214"
WS_URL = "ws://127.0.0.1:5173/ws-hardware"


async def run_bridge():
    print(f"[BLE-Bridge] Scanning for M5-TENNIS-IMU -> {WS_URL}", flush=True)
    while True:
        try:
            device = await BleakScanner.find_device_by_filter(
                lambda d, adv: (
                    (d.name and "M5-TENNIS" in d.name)
                    or (adv.local_name and "M5-TENNIS" in adv.local_name)
                    or SERVICE_UUID in [u.lower() for u in (adv.service_uuids or [])]
                ),
                timeout=6.0,
            )
            if not device:
                print("[BLE-Bridge] M5-TENNIS-IMU not found yet, retrying...", flush=True)
                await asyncio.sleep(1.0)
                continue

            print(f"[BLE-Bridge] Found {device.name} ({device.address}), connecting...", flush=True)

            async with websockets.connect(WS_URL, ping_interval=20) as ws:
                await ws.send('{"type":"info","board":"M5Core2","imu":"MPU6886","ble":"M5-TENNIS-IMU (Wireless BLE)"}')
                loop = asyncio.get_running_loop()
                pkt_count = 0
                last_log = time.time()
                queue: asyncio.Queue[str] = asyncio.Queue(maxsize=32)

                def on_notify(_sender, data: bytearray):
                    if len(data) < 13:
                        return
                    ax_i, ay_i, az_i, gx_i, gy_i, gz_i, flags = struct.unpack("<hhhhhhB", data[:13])
                    line = (
                        f"I,{ax_i/1000:.3f},{ay_i/1000:.3f},{az_i/1000:.3f},"
                        f"{gx_i/10:.1f},{gy_i/10:.1f},{gz_i/10:.1f},{flags & 1}"
                    )
                    # Drop oldest packet if queue ever backs up -> always zero lag!
                    if queue.full():
                        try:
                            queue.get_nowait()
                        except asyncio.QueueEmpty:
                            pass
                    loop.call_soon_threadsafe(queue.put_nowait, line)

                async def sender_task():
                    nonlocal pkt_count, last_log
                    while True:
                        line = await queue.get()
                        await ws.send(line)
                        pkt_count += 1
                        now = time.time()
                        if now - last_log >= 2.0:
                            hz = pkt_count / (now - last_log)
                            print(f"[BLE-Bridge] LIVE wireless stream: {hz:.1f} Hz | {line}", flush=True)
                            pkt_count = 0
                            last_log = now

                async with BleakClient(device, timeout=10.0) as client:
                    print("[BLE-Bridge] BLE CONNECTED! Subscribing to 100 Hz IMU...", flush=True)
                    await client.start_notify(IMU_CHAR_UUID, on_notify)
                    sender = asyncio.create_task(sender_task())
                    try:
                        while client.is_connected and not sender.done():
                            await asyncio.sleep(0.5)
                        if sender.done() and not sender.cancelled():
                            exc = sender.exception()
                            if exc is not None:
                                raise exc
                    finally:
                        sender.cancel()
                        try:
                            await sender
                        except asyncio.CancelledError:
                            pass
                        print("[BLE-Bridge] BLE disconnected, will auto-reconnect...", flush=True)
        except Exception as e:
            print(f"[BLE-Bridge] Reconnecting after error: {e}", flush=True)
            await asyncio.sleep(1.5)


if __name__ == "__main__":
    asyncio.run(run_bridge())
