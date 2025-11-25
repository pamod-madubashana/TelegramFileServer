import os
import sys
import math
from venv import logger
import zlib
import json
import asyncio
import secrets
import mimetypes
import traceback

from pathlib import Path
from typing import Tuple, Dict, Union
from fastapi import APIRouter, Request, HTTPException, Depends
from fastapi.responses import StreamingResponse, JSONResponse
from concurrent.futures import ThreadPoolExecutor

from pyrogram import Client
from pyrogram import raw
from pyrogram import utils
from pyrogram.errors import AuthBytesInvalid
from pyrogram.session import Session , Auth
from pyrogram.file_id import FileId, FileType, ThumbnailSource
from src.Database import database

from d4rk.Logs import setup_logger


from src.Config import APP_NAME

current_dir = Path(__file__).parent
parent_dir = current_dir.parent
sys.path.append(str(parent_dir))

LOGGER = setup_logger(__name__)


class InvalidHash(Exception):
    message = 'Invalid hash!'


class FIleNotFound(Exception):
    message = 'File not found!'


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
        LOGGER.error(f"Error getting file IDs: {e}")
        return None


class ByteStreamer:
    def __init__(self, client: Client):
        self.clean_timer = 30 * 60
        self.client: Client = client
        self.__cached_file_ids: Dict[int, FileId] = {}
        asyncio.create_task(self.clean_cache())

    async def get_file_properties(self, chat_id: int, message_id: int) -> FileId:
        if message_id not in self.__cached_file_ids:
            file_id = await get_file_ids(self.client, int(chat_id), int(message_id))
            if not file_id:
                LOGGER.info('Message with ID %s not found!', message_id)
                raise FIleNotFound
            self.__cached_file_ids[message_id] = file_id
        return self.__cached_file_ids[message_id]

    async def yield_file(self, file_id: FileId, client, offset: int, first_part_cut: int, last_part_cut: int, part_count: int, chunk_size: int) -> Union[str, None]: # type: ignore
        # Add workload to the client
        if hasattr(client, 'add_workload'):
            client.add_workload(1)
            
        LOGGER.debug(f"Starting to yielding file with client.")
        media_session = await self.generate_media_session(client, file_id)
        current_part = 1
        location = await self.get_location(file_id)
        try:
            r = await media_session.send(raw.functions.upload.GetFile(location=location, offset=offset, limit=chunk_size))
            if isinstance(r, raw.types.upload.File):
                while True:
                    chunk = r.bytes
                    if not chunk:
                        break
                    elif part_count == 1:
                        yield chunk[first_part_cut:last_part_cut]
                    elif current_part == 1:
                        yield chunk[first_part_cut:]
                    elif current_part == part_count:
                        yield chunk[:last_part_cut]
                    else:
                        yield chunk

                    current_part += 1
                    offset += chunk_size

                    if current_part > part_count:
                        break
                    
                    r = await media_session.send(
                        raw.functions.upload.GetFile(
                            location=location, offset=offset, limit=chunk_size
                        ),
                    )
        except (TimeoutError, AttributeError):
            pass
        finally:
            LOGGER.debug("Finished yielding file with {current_part} parts.")
            # Remove workload when streaming is complete
            if hasattr(client, 'add_workload'):
                client.add_workload(-1)

    async def generate_media_session(self, client: Client, file_id: FileId) -> Session:
        media_session = client.media_sessions.get(file_id.dc_id, None)
        if media_session is None:
            if file_id.dc_id != await client.storage.dc_id():
                media_session = Session(
                    client,
                    file_id.dc_id,
                    await Auth(client, file_id.dc_id, await client.storage.test_mode()).create(),
                    await client.storage.test_mode(),
                    is_media=True,
                )
                await media_session.start()
                for _ in range(6):
                    exported_auth = await client.invoke(raw.functions.auth.ExportAuthorization(dc_id=file_id.dc_id))
                    try:
                        await media_session.send(raw.functions.auth.ImportAuthorization(id=exported_auth.id, bytes=exported_auth.bytes))
                        break
                    except AuthBytesInvalid:
                        LOGGER.debug(f"Invalid authorization bytes for DC {file_id.dc_id}, retrying...")
                    except OSError:
                        LOGGER.debug(f"Connection error, retrying...")
                        await asyncio.sleep(2)
                else:
                    await media_session.stop()
                    LOGGER.debug(f"Failed to establish media session for DC {file_id.dc_id} after multiple retries")
                    return None 
            else:
                media_session = Session(
                    client,
                    file_id.dc_id,
                    await client.storage.auth_key(),
                    await client.storage.test_mode(),
                    is_media=True,
                )
                await media_session.start()
            LOGGER.debug(f"Created media session for DC {file_id.dc_id}")
            client.media_sessions[file_id.dc_id] = media_session
        else:
            LOGGER.debug(f"Using cached media session for DC {file_id.dc_id}")
        return media_session

    @staticmethod
    async def get_location(file_id: FileId) -> Union[raw.types.InputPhotoFileLocation, raw.types.InputDocumentFileLocation, raw.types.InputPeerPhotoFileLocation]:
        file_type = file_id.file_type
        if file_type == FileType.CHAT_PHOTO:
            if file_id.chat_id > 0:
                peer = raw.types.InputPeerUser(
                    user_id=file_id.chat_id, access_hash=file_id.chat_access_hash)
            else:
                if file_id.chat_access_hash == 0:
                    peer = raw.types.InputPeerChat(chat_id=-file_id.chat_id)
                else:
                    peer = raw.types.InputPeerChannel(channel_id=utils.get_channel_id(
                        file_id.chat_id), access_hash=file_id.chat_access_hash)
            location = raw.types.InputPeerPhotoFileLocation(peer=peer,
                                                            volume_id=file_id.volume_id,
                                                            local_id=file_id.local_id,
                                                            big=file_id.thumbnail_source == ThumbnailSource.CHAT_PHOTO_BIG)
        elif file_type == FileType.PHOTO:
            location = raw.types.InputPhotoFileLocation(id=file_id.media_id,
                                                        access_hash=file_id.access_hash,
                                                        file_reference=file_id.file_reference,
                                                        thumb_size=file_id.thumbnail_size)
        else:
            location = raw.types.InputDocumentFileLocation(id=file_id.media_id,
                                                           access_hash=file_id.access_hash,
                                                           file_reference=file_id.file_reference,
                                                           thumb_size=file_id.thumbnail_size)
        return location

    async def clean_cache(self) -> None:
        while True:
            await asyncio.sleep(self.clean_timer)
            self.__cached_file_ids.clear()
            LOGGER.debug("Cleaned the cache")


router = APIRouter(tags=["Streaming"])
class_cache = {}


def parse_range_header(range_header: str, file_size: int) -> Tuple[int, int]:
    if not range_header:
        return 0, file_size - 1
    try:
        range_value = range_header.replace("bytes=", "")
        from_str, until_str = range_value.split("-")
        from_bytes = int(from_str)
        until_bytes = int(until_str) if until_str else file_size - 1
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid Range header: {e}")

    if (until_bytes > file_size - 1) or (from_bytes < 0) or (until_bytes < from_bytes):
        raise HTTPException(
            status_code=416,
            detail="Requested Range Not Satisfiable",
            headers={"Content-Range": f"bytes */{file_size}"},
        )

    return from_bytes, until_bytes


@router.get("/dl/{file_name:path}")
@router.head("/dl/{file_name:path}")
async def stream_handler(request: Request, file_name: str):
    # For download, explicitly set is_watch to False
    request.state.is_watch = False
    # Handle download request
    
    # Decode URL encoded file name
    import urllib.parse
    decoded_file_name = urllib.parse.unquote(file_name)
    
    # Get bot manager from app state
    bot_manager = request.app.state.bot_manager if hasattr(request.app.state, 'bot_manager') else None
    if not bot_manager:
        raise HTTPException(status_code=500, detail="Bot manager not available")
    
    client: Client = bot_manager.get_least_busy_client() if hasattr(bot_manager, 'get_least_busy_client') else None
    if not client:
        raise HTTPException(status_code=500, detail="No available bot clients")
    
    # Look up the file in the database using the file name
    try:
        # Search for the file in the Files collection by file name
        # First try exact match
        file_data = database.Files.find_one({"file_name": decoded_file_name})
        
        # If not found, try with path variations
        if not file_data:
            # Try with leading slash
            file_data = database.Files.find_one({"file_name": decoded_file_name, "file_path": "/"})
        
        # If still not found, try to extract the file name from a path
        if not file_data:
            # Handle paths like /Home/Images/filename.jpg by extracting just the filename
            import os
            extracted_filename = os.path.basename(decoded_file_name)
            if extracted_filename != decoded_file_name:
                file_data = database.Files.find_one({"file_name": extracted_filename})
        
        if not file_data:
            print(f"File not found in database for name: {decoded_file_name}")
            raise HTTPException(status_code=404, detail="File not found")
        
        # Get file unique ID for Telegram lookup
        file_unique_id = file_data.get("file_unique_id")
        chat_id = file_data.get("chat_id")
        message_id = file_data.get("message_id")
        
        if not file_unique_id or not chat_id or not message_id:
            raise HTTPException(status_code=404, detail="File not found")
        
        # Reconstruct the full chat_id with -100 prefix if needed
            
    except ValueError as e:
        # Handle case where ID cannot be converted to integer
        print(f"ValueError converting file data: {e}")
        raise HTTPException(status_code=404, detail="Invalid file data")
    except Exception as e:
        print(f"Exception looking up file with name {decoded_file_name}: {e}")
        raise HTTPException(status_code=404, detail="File not found or inaccessible")
    
    try:
        message = await client.get_messages(chat_id, message_id)
        file = message.video or message.document or message.photo or message.audio or message.voice
        if not file:
            raise HTTPException(status_code=404, detail="File not found")
        logger.info(f"File found: {file}")
        file_hash = file.file_unique_id[:6]
    except Exception as e:
        print(f"Exception getting file from Telegram: {e}")
        raise HTTPException(status_code=404, detail="File not found or inaccessible")

    return await media_streamer(
        request,
        client=client,
        chat_id=chat_id,
        id=message_id,
        file=file,
        secure_hash=file_hash
    )

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
        raise HTTPException(status_code=400, detail=f"Invalid Range header: {e}")

    if from_bytes < 0 or until_bytes < from_bytes or until_bytes >= file_size:
        raise HTTPException(
            status_code=416,
            detail="Requested Range Not Satisfiable",
            headers={"Content-Range": f"bytes */{file_size}"},
        )

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

async def stream_handler_for_watch(request: Request, id: str, filename: str = None):
    # Handle watch request (this is separate from download handler)
    
    # Ensure is_watch flag is set for watch requests
    request.state.is_watch = True
    
    # Get bot manager from app state
    bot_manager = request.app.state.bot_manager if hasattr(request.app.state, 'bot_manager') else None
    if not bot_manager:
        raise HTTPException(status_code=500, detail="Bot manager not available")
    
    # Get the least busy client from bot manager
    client: Client = bot_manager.get_least_busy_client() if hasattr(bot_manager, 'get_least_busy_client') else None
    if not client:
        raise HTTPException(status_code=500, detail="No available bot clients")
    
    # Look up the file in the database using the file unique ID
    try:
        
        # Search for the file in all movie resolutions
        file_data = database.Movies.get_movie_file_by_id(id)
        if not file_data or not file_data.file_data or len(file_data.file_data) == 0:
            print(f"File not found in database for ID: {id}")
            raise HTTPException(status_code=404, detail="File not found")
        
        # If a specific filename is requested, find the matching file_data entry
        file_info = None
        if filename:
            for fd in file_data.file_data:
                if fd.filename == filename:
                    file_info = fd
                    break
        
        # If no specific filename matched or no filename provided, use the first file_data
        if not file_info:
            file_info = file_data.file_data[0]
            
        chat_id = file_info.chat_id
        message_id = file_info.message_id
        
        if not chat_id or not message_id:
            raise HTTPException(status_code=404, detail="File not found")
                    
    except ValueError as e:
        # Handle case where ID cannot be converted to integer
        print(f"ValueError converting ID {id} to integer: {e}")
        raise HTTPException(status_code=404, detail="Invalid file ID format")
    except Exception as e:
        print(f"Exception looking up file with ID {id}: {e}")
        raise HTTPException(status_code=404, detail="File not found or inaccessible")
    
    try:
        message = await client.get_messages(chat_id, message_id)
        file = message.video or message.document or message.audio or message.voice or message.photo
        if not file:
            raise HTTPException(status_code=404, detail="File not found")
        file_hash = file.file_unique_id[:6]
    except Exception as e:
        print(f"Exception getting file from Telegram: {e}")
        raise HTTPException(status_code=404, detail="File not found or inaccessible")

    return await media_streamer(
        request,
        client=client,
        chat_id=chat_id,
        id=message_id,
        file=file,
        secure_hash=file_hash
    )


@router.get("/watch/{file_name:path}")
async def watch_handler(request: Request, file_name: str):
    # Check if this is a request for the video content (not the player page)
    # We can detect this by checking if the Accept header contains video/ but NOT text/html
    # This prevents browsers from accidentally triggering streaming when they want the player page
    accept_header = request.headers.get("Accept", "")
    
    # Decode URL encoded file name
    import urllib.parse
    decoded_file_name = urllib.parse.unquote(file_name)
    
    # If the request is specifically asking for video content and NOT html, stream it
    if "video/" in accept_header and "text/html" not in accept_header:
        # This is a request for the video content, stream it
        request.state.is_watch = True
        return await stream_handler(request, file_name)
    # Also check for direct range requests which are typically video streaming requests
    elif request.headers.get("Range"):
        # This is a range request, definitely a streaming request
        request.state.is_watch = True
        return await stream_handler(request, file_name)
    else:
        # This is a request for the video player page
        # Look up the file in the database using the file name
        try:
            # Search for the file in the Files collection by file name
            # First try exact match
            file_data = database.Files.find_one({"file_name": decoded_file_name})
            
            # If not found, try with path variations
            if not file_data:
                # Try with leading slash
                file_data = database.Files.find_one({"file_name": decoded_file_name, "file_path": "/"})
            
            if not file_data:
                print(f"File not found in database for name: {decoded_file_name}")
                raise HTTPException(status_code=404, detail="File not found")
            
            file_name_str = file_data.get("file_name") or f"{secrets.token_hex(2)}.unknown"
            mime_type = resolve_mime_type(file_name_str)
            
            # Create a title from the file information
            title = file_data.get("file_name") or "Unknown File"

            return templates.TemplateResponse("video_player.html", {
                "request": request,
                "id": file_data.get("file_unique_id"),  # Use unique ID for player
                "title": f"{title}",
                "mime_type": mime_type,  # Default to MP4, will be overridden by browser
                "qualities": [],  # No qualities for simple file server
                "app_name": APP_NAME  # Pass app name to template
            })
        except Exception as e:
            print(f"Exception looking up file with name {decoded_file_name}: {e}")
            raise HTTPException(status_code=404, detail="File not found or inaccessible")


@router.get("/watch/{id}/{quality}")
async def watch_quality_handler(request: Request, id: str, quality: str):
    # Check if this is a request for the video content (not the player page)
    # We can detect this by checking if the Accept header contains video/ but NOT text/html
    # This prevents browsers from accidentally triggering streaming when they want the player page
    accept_header = request.headers.get("Accept", "")
    
    # If the request is specifically asking for video content and NOT html, stream it
    if "video/" in accept_header and "text/html" not in accept_header:
        # This is a request for the video content, stream it
        request.state.is_watch = True
        # Find the file with the specified quality
        try:
            # Search for the file in all movie resolutions
            file_data = database.Movies.get_movie_file_by_id(id)
            if not file_data or not file_data.file_data or len(file_data.file_data) == 0:
                print(f"File not found in database for ID: {id}")
                raise HTTPException(status_code=404, detail="File not found")
            
            # If we found the file, stream it
            return await stream_handler_for_watch(request, id)
        except Exception as e:
            print(f"Exception looking up file with ID {id}: {e}")
            raise HTTPException(status_code=404, detail="File not found or inaccessible")
    else:
        # This is a request for the video player page
        # Look up the file in the database using the file unique ID
        try:
            # Search for the file in all movie resolutions
            file_data = database.Movies.get_movie_file_by_id(id)
            if not file_data or not file_data.file_data or len(file_data.file_data) == 0:
                print(f"File not found in database for ID: {id}")
                raise HTTPException(status_code=404, detail="File not found")
            
            # Get the first file data (should be the main file)
            file_info = file_data.file_data[0]
            file_name = file_info.filename or f"{secrets.token_hex(2)}.unknown"
            mime_type = resolve_mime_type(file_name)
            
            # Create a title from the file information
            title = file_data.display_name or "Unknown Movie"
            
            # Get all available qualities for this movie
            qualities = []
            qualities_data = database.Movies.get_movie_qualities_by_id(id)
            print(f"Qualities data for file ID {id}: {qualities_data}")  # Debug print
            
            # Create a list of unique resolutions with their file IDs
            resolution_map = {}
            for quality_data in qualities_data:
                resolution = quality_data["resolution"]
                # Always take the first file ID for each resolution
                if resolution not in resolution_map:
                    resolution_map[resolution] = quality_data["file_id"]
            
            # Convert to the format expected by the template
            for resolution, file_id in resolution_map.items():
                qualities.append({
                    "resolution": resolution,
                    "file_id": file_id
                })
            
            # Sort qualities by resolution (higher resolution first)
            def resolution_sort_key(quality):
                resolution = quality["resolution"].upper()
                # Extract numeric part from resolution string
                import re
                match = re.search(r'(\d+)', resolution)
                if match:
                    return int(match.group(1))
                # Handle non-numeric resolutions
                priority_map = {
                    'SD': 1, 'HD': 3, 'FHD': 5, 'UHD': 9
                }
                return priority_map.get(resolution, 0)
            
            qualities.sort(key=resolution_sort_key, reverse=True)
            
            print(f"Available qualities: {qualities}")  # Debug print
            
            # Get app name from config or environment
            
            # Return JSON with stream info instead of HTML template
            return JSONResponse({
                "id": id,
                "title": title,
                "mime_type": mime_type,
                "qualities": qualities,
                "stream_url": f"/dl/{id}/{file_name}",
                "app_name": APP_NAME
            })
        except Exception as e:
            print(f"Exception looking up file with ID {id}: {e}")
            raise HTTPException(status_code=404, detail="File not found or inaccessible")


async def media_streamer(
    request: Request,
    client,
    chat_id: int,
    id: int,
    file: raw.types.MessageMediaDocument,
    secure_hash: str,
) -> StreamingResponse:
    range_header = request.headers.get("Range", "")
    
    # Add workload to the client
    if hasattr(client, 'add_workload'):
        client.add_workload(1)
    tg_connect = class_cache.get(client)
    if not tg_connect:
        tg_connect = ByteStreamer(client)
        class_cache[client] = tg_connect

    file_id = await tg_connect.get_file_properties(chat_id=chat_id, message_id=id)
    # if str(file_id.media_id)[:6] != secure_hash:
    #     raise InvalidHash

    file_size = file.file_size
    from_bytes, until_bytes = parse_range_header(range_header, file_size)

    chunk_size = 1024 * 1024
    offset = from_bytes - (from_bytes % chunk_size)
    first_part_cut = from_bytes - offset
    last_part_cut = (until_bytes % chunk_size) + 1
    req_length = until_bytes - from_bytes + 1
    part_count = math.ceil(until_bytes / chunk_size) - math.floor(offset / chunk_size)

    body = tg_connect.yield_file(
        file_id, client, offset, first_part_cut, last_part_cut, part_count, chunk_size
    )

    # Check if this is a watch request
    is_watch = hasattr(request.state, 'is_watch') and request.state.is_watch
    

    if hasattr(file, 'file_name'):
        file_name = file.file_name
    elif hasattr(file, "width"):
        file_name = f"Photo_{file.file_unique_id}.jpg"
    else: 
        file_name = f"Media_{file.file_unique_id}"
    
    if hasattr(file, 'mime_type'):
        mime_type = file.mime_type
    else:
        mime_type = mimetypes.guess_type(file_name)[0] or "application/octet-stream"
    # For watch requests, try to use a more browser-friendly MIME type if needed
    if is_watch and mime_type == "application/octet-stream":
        # If we can't determine the MIME type, try to guess based on file extension
        guessed_mime = mimetypes.guess_type(file_name)[0]
        if guessed_mime:
            mime_type = guessed_mime
        else:
            # For video files, use a generic video MIME type that most browsers can handle
            ext = file_name.rsplit(".", 1)[-1].lower() if "." in file_name else ""
            if ext in ("mp4", "m4v"):
                mime_type = "video/mp4"
            elif ext in ("webm",):
                mime_type = "video/webm"
            elif ext in ("mkv",):
                mime_type = "video/x-matroska"
            elif ext in ("mov",):
                mime_type = "video/quicktime"
            elif ext in ("avi",):
                mime_type = "video/x-msvideo"
            elif ext in ("flv",):
                mime_type = "video/x-flv"
            elif ext in ("wmv",):
                mime_type = "video/x-ms-wmv"
    
    if not file_name and "/" in mime_type:
        file_name = f"{secrets.token_hex(2)}.{mime_type.split('/')[1]}"

    content_disposition = 'inline; filename="{}"'.format(file_name) if is_watch else 'attachment; filename="{}"'.format(file_name)
    
    headers = {
        "Content-Type": mime_type,
        "Content-Length": str(req_length),
        "Content-Disposition": content_disposition,
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600, immutable",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    }
    
    # Add additional headers for video streaming
    if is_watch and mime_type and (mime_type.startswith('video/') or mime_type.startswith('audio/')):
        headers["X-Content-Type-Options"] = "nosniff"
        headers["X-Frame-Options"] = "SAMEORIGIN"
    
    if range_header:
        headers["Content-Range"] = f"bytes {from_bytes}-{until_bytes}/{file_size}"
        status_code = 206
    else:
        status_code = 200
    
    # Remove workload when streaming is complete
    if hasattr(client, 'add_workload'):
        client.add_workload(-1)
    
    return StreamingResponse(
        status_code=status_code,
        content=body,
        headers=headers,
        media_type=mime_type,
    )
