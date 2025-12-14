# src/Backend/modules/streaming_utils.py

import os
import sys
import math
import zlib
import json
import asyncio
import secrets
import mimetypes
import traceback
from pathlib import Path
from typing import Tuple, Dict, Union
from concurrent.futures import ThreadPoolExecutor

from pyrogram import Client
from pyrogram import raw
from pyrogram import utils
from pyrogram.errors import AuthBytesInvalid
from pyrogram.session import Session , Auth
from pyrogram.file_id import FileId, FileType, ThumbnailSource

executor = ThreadPoolExecutor()

def compress_data(data):
    return zlib.compress(data.encode(), level=zlib.Z_BEST_COMPRESSION)

def decompress_data(data):
    return zlib.decompress(data).decode()

def base62_encode(data):
    BASE62_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
    num = int.from_bytes(data, 'big')
    base62 = []
    while num:
        num, rem = divmod(num, 62)
        base62.append(BASE62_ALPHABET[rem])
    return ''.join(reversed(base62)) or '0'

def base62_decode(data):
    BASE62_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
    num = 0
    for char in data:
        num = num * 62 + BASE62_ALPHABET.index(char)
    return num.to_bytes((num.bit_length() + 7) // 8, 'big') or b'\0'

async def async_compress_data(data):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(executor, compress_data, data)

async def async_decompress_data(data):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(executor, decompress_data, data)

async def async_base62_encode(data):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(executor, base62_encode, data)

async def async_base62_decode(data):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(executor, base62_decode, data)

async def encode_string(data):
    json_data = json.dumps(data)
    compressed_data = await async_compress_data(json_data)
    return await async_base62_encode(compressed_data)

async def decode_string(encoded_data):
    compressed_data = await async_base62_decode(encoded_data)
    json_data = await async_decompress_data(compressed_data)
    return json.loads(json_data)

async def get_file_ids(client: Client, chat_id: int, message_id: int) -> FileId:
    """
    Get file IDs from a message
    """
    try:
        message = await client.get_messages(chat_id, message_id)
        if not message:
            return None
            
        file = message.video or message.document or message.audio or message.voice or message.photo
        if not file:
            return None
            
        return FileId.decode(file.file_id) if file.file_id else None
    except Exception as e:
        # Logger should be passed from the calling function
        return None

def parse_range_header(range_header: str, file_size: int) -> Tuple[int, int]:
    """
    Accepts "bytes=X-Y" and returns (from_bytes, until_bytes) inclusive.
    If no range_header, returns full range (0, file_size - 1).
    Raises HTTPException 416 for bad requests.
    """
    if not range_header:
        return 0, file_size - 1
    try:
        range_value = range_header.strip().lower()
        if not range_value.startswith("bytes="):
            raise ValueError("Range must start with 'bytes='")
        range_value = range_value[len("bytes="):]
        from_str, until_str = range_value.split("-")
        from_bytes = int(from_str) if from_str else 0
        until_bytes = int(until_str) if until_str else file_size - 1
    except Exception as e:
        # This should raise an HTTPException in the calling function
        raise ValueError(f"Invalid Range header: {e}")

    if from_bytes < 0 or until_bytes < from_bytes or until_bytes >= file_size:
        # This should raise an HTTPException in the calling function
        raise ValueError("Requested Range Not Satisfiable")

    return from_bytes, until_bytes

def resolve_mime_type(file_name: str, explicit_mime: str | None = None, is_watch: bool = False) -> str:
    # explicit_mime from Telegram is best
    if explicit_mime and explicit_mime != "application/octet-stream":
        return explicit_mime

    guessed = mimetypes.guess_type(file_name)[0]
    if guessed:
        return guessed

    # some helpful fallbacks
    ext = file_name.rsplit(".", 1)[-1].lower() if "." in file_name else ""
    if ext == "mkv":
        return "video/x-matroska"
    if ext in ("ts",):
        return "video/mp2t"
    if ext in ("m3u8", "m3u"):
        # HLS playlists
        return "application/vnd.apple.mpegurl"
    if ext in ("mp4", "m4v"):
        return "video/mp4"
    if ext in ("webm",):
        return "video/webm"
    if ext in ("mov",):
        return "video/quicktime"
    if ext in ("avi",):
        return "video/x-msvideo"
    if ext in ("flv",):
        return "video/x-flv"
    if ext in ("wmv",):
        return "video/x-ms-wmv"

    # last resort
    return "application/octet-stream"