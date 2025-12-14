# src/Backend/routes/files_routes.py

from fastapi import APIRouter, Request, Depends, HTTPException, File, UploadFile, Form, Response , Query
from pydantic import BaseModel
from bson import ObjectId
import os
import datetime
import aiofiles
import re
from typing import List, Dict, Any, Optional
from dataclasses import asdict

from ..security.credentials import require_auth, User
from src.Database import database
from d4rk.Logs import setup_logger

# For thumbnail route
from pyrogram import Client

logger = setup_logger("files_routes")

# Create router with updated prefix
router = APIRouter(prefix="/files", tags=["Files"])

# Global variable for auth tokens (should be imported from main app)
_auth_tokens = {}

@router.get("/")
async def get_all_files_route(
    path: str = Query(default="/", description="Folder path to fetch files from"),
    user: User = Depends(require_auth)
):
    try:
        # Fetch files for the specified path and user
        logger.info(f"Fetching files for path {path} and user {user}")
        # Use the user's Telegram ID as the user identifier
        user_id = str(user.telegram_user_id) if user.telegram_user_id else user.username
        files_data = database.Files.get_files_by_path(path, user_id)
        files_list = []
        for f in files_data:
            f_dict = asdict(f)
            f_dict['id'] = str(f_dict['id']) # Convert ObjectId to string
            f_dict['file_unique_id'] = f.file_unique_id  # Include file_unique_id for streaming
            
            files_list.append(f_dict)
        return {"files": files_list}
    except Exception as e:
        logger.error(f"Error fetching files for path {path}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class MoveFileRequest(BaseModel):
    file_id: str
    target_path: str

class CopyFileRequest(BaseModel):
    file_id: str
    target_path: str

class DeleteFileRequest(BaseModel):
    file_id: str

class RenameFileRequest(BaseModel):
    file_id: str
    new_name: str

@router.post("/move")
async def move_file_route(request: MoveFileRequest, user: User = Depends(require_auth)):
    try:
        # Use the user's Telegram ID as the user identifier
        user_id = str(user.telegram_user_id) if user.telegram_user_id else user.username
        # Check if user owns the file
        if not database.Files.check_file_owner(request.file_id, user_id):
            raise HTTPException(status_code=403, detail="Access denied")
            
        # Get the file by ID
        file_data = database.Files.find_one({"_id": ObjectId(request.file_id)})
        if not file_data:
            raise HTTPException(status_code=404, detail="File not found")
        
        # Update the file's path and modified date
        database.Files.update_one(
            {"_id": ObjectId(request.file_id), "owner_id": user_id},
            {"$set": {"file_path": request.target_path, "modified_date": datetime.datetime.utcnow().isoformat()}}
        )
        
        return {"message": "File moved successfully"}
    except Exception as e:
        logger.error(f"Error moving file: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/copy")
async def copy_file_route(request: CopyFileRequest, user: User = Depends(require_auth)):
    try:
        # Use the user's Telegram ID as the user identifier
        user_id = str(user.telegram_user_id) if user.telegram_user_id else user.username
        # Check if user owns the file
        if not database.Files.check_file_owner(request.file_id, user_id):
            raise HTTPException(status_code=403, detail="Access denied")
            
        # Get the file by ID
        file_data = database.Files.find_one({"_id": ObjectId(request.file_id)})
        if not file_data:
            raise HTTPException(status_code=404, detail="File not found")
        
        # Create a copy of the file with the new path
        new_file_data = file_data.copy()
        new_file_data["_id"] = ObjectId()  # Generate new ID
        new_file_data["file_path"] = request.target_path
        new_file_data["modified_date"] = datetime.datetime.utcnow().isoformat()  # Set new modified date for copied file
        # Preserve the owner when copying
        new_file_data["owner_id"] = user_id
        
        # For copied files, we need to handle the unique ID properly
        # For now, we'll keep the same file_unique_id since it refers to the Telegram file
        # In a real implementation, you might want to duplicate the file in Telegram as well
        
        database.Files.insert_one(new_file_data)
        
        return {"message": "File copied successfully", "new_file_id": str(new_file_data["_id"])}
    except Exception as e:
        logger.error(f"Error copying file: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/rename")
async def rename_file_route(request: RenameFileRequest, user: User = Depends(require_auth)):
    try:
        # Use the user's Telegram ID as the user identifier
        user_id = str(user.telegram_user_id) if user.telegram_user_id else user.username
        # Rename the file/folder with owner validation
        success = database.Files.rename_file(request.file_id, request.new_name, user_id)
        
        if success:
            return {"message": "Item renamed successfully"}
        else:
            raise HTTPException(status_code=404, detail="File not found")
    except Exception as e:
        logger.error(f"Error renaming file: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/delete")
async def delete_file_route(request: DeleteFileRequest, user: User = Depends(require_auth)):
    try:
        # Use the user's Telegram ID as the user identifier
        user_id = str(user.telegram_user_id) if user.telegram_user_id else user.username
        # Check if user owns the file
        if not database.Files.check_file_owner(request.file_id, user_id):
            raise HTTPException(status_code=403, detail="Access denied")
            
        # Get the file by ID to check if it exists
        file_data = database.Files.find_one({"_id": ObjectId(request.file_id), "owner_id": user_id})
        if not file_data:
            raise HTTPException(status_code=404, detail="File not found")
        
        # Check if this is a folder
        if file_data.get("file_type") == "folder":
            # For folders, we also need to delete all files inside the folder
            folder_path = file_data.get("file_path", "/")
            folder_name = file_data.get("file_name", "")
            
            # Construct the full folder path
            if folder_path == "/":
                full_folder_path = f"/{folder_name}"
            else:
                full_folder_path = f"{folder_path}/{folder_name}"
            
            # Delete all files in the folder (owned by the user)
            database.Files.delete_many({"file_path": full_folder_path, "owner_id": user_id})
            
            # Also delete any subfolders and files inside this folder
            # Delete items that are inside this folder (path starts with full_folder_path + "/")
            database.Files.delete_many({
                "file_path": {"$regex": f"^{re.escape(full_folder_path)}/"},
                "owner_id": user_id
            })
        
        # Delete the file/folder itself
        result = database.Files.delete_one({"_id": ObjectId(request.file_id), "owner_id": user_id})
        
        if result.deleted_count == 0:
            raise HTTPException(status_code=404, detail="File not found")
        
        return {"message": "Item deleted successfully"}
    except Exception as e:
        logger.error(f"Error deleting file: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# Add file upload endpoint
@router.post("/upload")
async def upload_file(
    request: Request,  # Make request parameter required to access bot manager
    file: UploadFile = File(...),
    path: str = Form(default="/", description="Destination path for the uploaded file"),
    user: User = Depends(require_auth)
):
    try:
        # DEBUG: Log the received path and file info
        print(f"Received upload request with path: {path}")
        print(f"File name: {file.filename}, File size: {file.size}, Content type: {file.content_type}")
        print(f"User: {user}")
        # Create the tg_files directory if it doesn't exist
        tg_files_dir = os.path.join(os.getcwd(), "tg_files")
        os.makedirs(tg_files_dir, exist_ok=True)
        
        # Save the file locally first
        file_path = os.path.join(tg_files_dir, file.filename)
        
        # Write file content asynchronously
        contents = await file.read()
        
        # Check if file is empty
        if len(contents) == 0:
            raise HTTPException(status_code=400, detail="Cannot upload empty files")
        
        async with aiofiles.open(file_path, 'wb') as f:
            await f.write(contents)
        
        # Check if user has verified their Telegram account
        if not user.telegram_user_id:
            # Clean up the temporary file
            if file_path and os.path.exists(file_path):
                try:
                    os.remove(file_path)
                except Exception as e:
                    logger.warning(f"Failed to clean up temporary file {file_path}: {e}")
            # Return a specific error that will trigger the frontend to show verification dialog
            raise HTTPException(status_code=400, detail="TELEGRAM_NOT_VERIFIED: Please verify your Telegram account before uploading files")
        
        # Get the user's index chat ID
        user_data = database.Users.find_one({"telegram_user_id": user.telegram_user_id})
        if not user_data or "index_chat_id" not in user_data:
            # Clean up the temporary file
            if file_path and os.path.exists(file_path):
                try:
                    os.remove(file_path)
                except Exception as e:
                    logger.warning(f"Failed to clean up temporary file {file_path}: {e}")
            raise HTTPException(status_code=400, detail="User index chat not found")        
        chat_id = user_data["index_chat_id"]
        
        # Get the bot manager and client from the request
        # Access bot_manager from app state (injected by main application)
        if not hasattr(request, 'app') or not hasattr(request.app.state, 'bot_manager'):
            raise HTTPException(status_code=503, detail="Bot manager not available")
        
        bot_manager = request.app.state.bot_manager
        if not bot_manager:
            raise HTTPException(status_code=503, detail="Bot manager not available")
        
        # Get a client to use for uploading
        client: Client = bot_manager.get_least_busy_client() if hasattr(bot_manager, 'get_least_busy_client') else None
        if not client:
            raise HTTPException(status_code=500, detail="No available bot clients")
        
        # Determine file type based on extension
        file_extension = os.path.splitext(file.filename)[1].lower()
        sent_message = None
        
        # Upload the file to Telegram based on its extension
        try:
            if file_extension in ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']:
                # Send as photo
                sent_message = await client.send_photo(
                    chat_id=chat_id,
                    photo=file_path,
                    caption=f"Uploaded file: {file.filename}"
                )
            elif file_extension in ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm']:
                # Send as video
                sent_message = await client.send_video(
                    chat_id=chat_id,
                    video=file_path,
                    caption=f"Uploaded file: {file.filename}"
                )
            elif file_extension in ['.mp3', '.wav', '.ogg', '.flac', '.m4a']:
                # Send as audio
                sent_message = await client.send_audio(
                    chat_id=chat_id,
                    audio=file_path,
                    caption=f"Uploaded file: {file.filename}"
                )
            else:
                # Send as document for all other file types
                sent_message = await client.send_document(
                    chat_id=chat_id,
                    document=file_path,
                    caption=f"Uploaded file: {file.filename}",
                    force_document=True
                )
        except Exception as e:
            # If specific media type upload fails, fall back to document
            logger.warning(f"Failed to upload as {file_extension}, falling back to document: {e}")
            sent_message = await client.send_document(
                chat_id=chat_id,
                document=file_path,
                caption=f"Uploaded file: {file.filename}",
                force_document=True
            )
        
        # Ensure we have a sent message
        if not sent_message:
            raise HTTPException(status_code=500, detail="Failed to upload file to Telegram")
        
        # Clean up the temporary file
        if file_path and os.path.exists(file_path):
            try:
                os.remove(file_path)
            except Exception as e:
                logger.warning(f"Failed to clean up temporary file {file_path}: {e}")
        
        # Get file information
        media = sent_message.document or sent_message.video or sent_message.audio or sent_message.photo or sent_message.voice
        if not media:
            raise HTTPException(status_code=500, detail="Failed to get file information from Telegram")
        
        # Determine file type based on the message content and extension
        file_type = "document"
        if hasattr(sent_message, 'video') and sent_message.video:
            file_type = "video"
        elif hasattr(sent_message, 'photo') and sent_message.photo:
            file_type = "photo"
        elif hasattr(sent_message, 'voice') and sent_message.voice:
            file_type = "voice"
        elif hasattr(sent_message, 'audio') and sent_message.audio:
            file_type = "audio"
        # Override with extension-based type if needed
        elif file_extension in ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']:
            file_type = "photo"
        elif file_extension in ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm']:
            file_type = "video"
        elif file_extension in ['.mp3', '.wav', '.ogg', '.flac', '.m4a']:
            file_type = "audio"
        
        # Get thumbnail if available
        thumbnail = None
        if hasattr(media, 'thumbs') and media.thumbs:
            thumbnail = media.thumbs[0].file_id if media.thumbs else None
        elif hasattr(media, 'file_id') and sent_message.photo:
            thumbnail = media.file_id
        
        # DEBUG: Log the path being saved to database
        print(f"Saving file to database with path: {path}")
        
        # Add file to database
        success = database.Files.add_file(
            chat_id=sent_message.chat.id,
            message_id=sent_message.id,
            thumbnail=thumbnail,
            file_type=file_type,
            file_unique_id=media.file_unique_id,
            file_size=media.file_size,
            file_name=file.filename,
            file_caption=f"Uploaded file: {file.filename}",
            file_path=path,  # Use the provided path
            owner_id=str(user.telegram_user_id)
        )
        
        if success:
            # Return complete file information for frontend to display immediately
            return {
                "message": "File uploaded successfully",
                "file": {
                    "id": str(sent_message.id),
                    "file_unique_id": media.file_unique_id,
                    "file_name": file.filename,
                    "file_path": path,
                    "file_type": file_type,
                    "file_size": media.file_size,
                    "thumbnail": thumbnail,
                    "modified": datetime.datetime.now().isoformat()
                }
            }
        else:
            raise HTTPException(status_code=500, detail="Failed to save file to database")
            
    except Exception as e:
        logger.error(f"Error uploading file: {e}")
        # Clean up the temporary file if it exists
        if 'file_path' in locals() and file_path and os.path.exists(file_path):
            try:
                os.remove(file_path)
            except Exception as e:
                logger.warning(f"Failed to clean up temporary file {file_path}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{file_id}/thumbnail")
async def get_file_thumbnail(file_id: str, request: Request, auth_token: str = None):
    # Check authentication - first try the normal auth, then check for token in query params
    try:
        # This will raise an exception if not authenticated via normal means
        user = require_auth(request)
    except HTTPException:
        # If normal auth fails, check for auth_token in query params
        if auth_token:
            # First check in-memory cache
            if auth_token in _auth_tokens:
                # Token is valid, proceed
                pass
            else:
                # Check in database if not found in memory
                try:
                    db_token_data = database.Users.get_auth_token(auth_token)
                    if db_token_data:
                        # Add to in-memory cache for future requests
                        _auth_tokens[auth_token] = {
                            "authenticated": True,
                            "username": db_token_data['username'],
                            "auth_method": db_token_data['auth_method'],
                            "created_at": db_token_data['created_at'].isoformat() if hasattr(db_token_data['created_at'], 'isoformat') else str(db_token_data['created_at'])
                        }
                        # Token is valid, proceed
                        pass
                    else:
                        # No valid authentication method
                        raise HTTPException(status_code=401, detail="Authentication required")
                except Exception as e:
                    logger.error(f"Failed to check auth token in database: {e}")
                    # No valid authentication method
                    raise HTTPException(status_code=401, detail="Authentication required")
        else:
            # No valid authentication method
            raise HTTPException(status_code=401, detail="Authentication required")
    
    try:
        bot_manager = request.app.state.bot_manager
        if not bot_manager:
            raise HTTPException(status_code=503, detail="Bot manager not available")

        # Get a client to use for downloading
        client: Client = bot_manager.get_least_busy_client() if hasattr(bot_manager, 'get_least_busy_client') else None
        if not client:
            raise HTTPException(status_code=500, detail="No available bot clients")
        
        photo_data = await client.download_media(file_id, in_memory=True)
        if photo_data:
            # Check if it's a BytesIO object
            if hasattr(photo_data, 'getvalue'):
                photo_bytes = photo_data.getvalue()
                if len(photo_bytes) > 0:
                    # Return the photo data
                    return Response(
                        content=photo_bytes,
                        media_type="image/jpeg",
                        headers={"Cache-Control": "max-age=3600"}  # Cache for 1 hour
                    )
            else:
                # If it's already bytes, return directly
                if len(photo_data) > 0:
                    return Response(
                        content=photo_data,
                        media_type="image/jpeg",
                        headers={"Cache-Control": "max-age=3600"}  # Cache for 1 hour
                    )
    except Exception as e:
        logger.error(f"Error downloading file thumbnail: {e}")
        raise HTTPException(status_code=500, detail=str(e))