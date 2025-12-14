# src/Backend/routes/folders_routes.py

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from ..security.credentials import require_auth, User
from src.Database import database
from d4rk.Logs import setup_logger

logger = setup_logger("folders_routes")

# Create router with updated prefix
router = APIRouter(prefix="/folders", tags=["Folders"])

class CreateFolderRequest(BaseModel):
    folderName: str
    currentPath: str

class CreateFolderPathRequest(BaseModel):
    fullPath: str

@router.post("/create")
async def create_folder_route(request: CreateFolderRequest, user: User = Depends(require_auth)):
    try:
        # Use the user's Telegram ID as the user identifier
        user_id = str(user.telegram_user_id) if user.telegram_user_id else user.username
        success = database.Files.create_folder(request.folderName, request.currentPath, user_id)
        if success:
            return {"message": f"Folder '{request.folderName}' created successfully"}
        else:
            raise HTTPException(status_code=400, detail="Folder already exists")
    except Exception as e:
        logger.error(f"Error creating folder: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/create-path")
async def create_folder_path_route(request: CreateFolderPathRequest, user: User = Depends(require_auth)):
    try:
        # Use the user's Telegram ID as the user identifier
        user_id = str(user.telegram_user_id) if user.telegram_user_id else user.username
        success = database.Files.create_folder_path(request.fullPath, user_id)
        if success:
            return {"message": f"Folder path '{request.fullPath}' created successfully"}
        else:
            return {"message": f"Folder path '{request.fullPath}' already exists or was created"}
    except Exception as e:
        logger.error(f"Error creating folder path: {e}")
        raise HTTPException(status_code=500, detail=str(e))