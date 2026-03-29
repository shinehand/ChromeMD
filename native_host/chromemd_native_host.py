#!/usr/bin/env python3
import json
import struct
import sys
from pathlib import Path

HOST_NAME = "com.chromemd.native_host"
HOST_VERSION = "1.0.0"


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) == 0:
        return None
    if len(raw_length) != 4:
        raise RuntimeError("failed to read message length")
    message_length = struct.unpack("<I", raw_length)[0]
    payload = sys.stdin.buffer.read(message_length)
    if len(payload) != message_length:
        raise RuntimeError("failed to read message payload")
    return json.loads(payload.decode("utf-8"))


def send_message(message):
    encoded = json.dumps(message).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def normalize_path(raw_path):
    if not raw_path or not isinstance(raw_path, str):
        raise ValueError("path is required")
    return Path(raw_path).expanduser().resolve()


def handle_status():
    return {
        "ok": True,
        "host": HOST_NAME,
        "version": HOST_VERSION
    }


def handle_write_file(message):
    file_path = normalize_path(message.get("path"))
    text = message.get("text", "")

    if not file_path.parent.exists():
        raise ValueError("parent directory does not exist")

    with open(file_path, "w", encoding="utf-8", newline="") as fp:
        fp.write(text)

    return {
        "ok": True,
        "path": str(file_path),
        "filename": file_path.name
    }


def dispatch(message):
    message_type = message.get("type")
    if message_type == "status":
        return handle_status()
    if message_type == "writeFile":
        return handle_write_file(message)
    raise ValueError(f"unsupported message type: {message_type}")


def main():
    while True:
        message = read_message()
        if message is None:
            break
        try:
            response = dispatch(message)
        except Exception as exc:  # noqa: BLE001
            response = {
                "ok": False,
                "error": str(exc)
            }
        send_message(response)


if __name__ == "__main__":
    main()
