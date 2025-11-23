# src/Database/Mongodb/_files.py

from typing import Any, Literal
from dataclasses import dataclass
from d4rk.Logs import setup_logger

from pymongo.collection import Collection
from pymongo.results import InsertOneResult, UpdateResult

logger = setup_logger(__name__)


@dataclass
class FileData:
    id: int 
    chat_id: int
    message_id: int
    thumbnail: str = None
    file_type: Literal["document","video","photo","voice","audio"] = None
    file_unique_id: str = None
    file_size: int = None
    file_name: str|None = None
    file_caption: str = None
    file_path: str = "/"  # Path where file is located, default is root
    
class Files(Collection):
    def __init__(self,collection: Collection) -> None:
        super().__init__(
            collection.database,
            collection.name,
            create=False,
            codec_options=collection.codec_options,
            read_preference=collection.read_preference,
            write_concern=collection.write_concern,
            read_concern=collection.read_concern
        )

    def check_if_exists(self, chat_id: int, message_id: int, file_unique_id: int) -> bool:
        r = self.find_one({"chat_id": chat_id, "message_id": message_id, "file_unique_id": file_unique_id})
        return False if not r else True
    
    def add_file(self, chat_id: int, message_id: int, thumbnail: str, file_type: str, file_unique_id: str, file_size: int, file_name: str, file_caption: str, file_path: str = "/"):
        saved = self.check_if_exists(chat_id, message_id, file_unique_id)
        if not saved:
            self.insert_one({
                "chat_id": chat_id,
                "message_id": message_id,
                "thumbnail": thumbnail,
                "file_type": file_type,
                "file_unique_id": file_unique_id,
                "file_size": file_size,
                "file_name": file_name,
                "file_caption": file_caption,
                "file_path": file_path  # Store file path
            })
            return True
        return None

    def get_all_files(self):
        files = self.find()
        return [FileData(
            id=file.get("_id"), 
            chat_id=file.get("chat_id"), 
            message_id=file.get("message_id"), 
            file_type=file.get("file_type"),
            thumbnail=file.get("thumbnail"), 
            file_unique_id=file.get("file_unique_id"), 
            file_size=file.get("file_size"), 
            file_name=file.get("file_name"), 
            file_caption=file.get("file_caption"),
            file_path=file.get("file_path", "/")  # Default to root if not set
            ) for file in files]
    
    def create_folder(self, folder_name: str, current_path: str = "/"):
        """Create a folder by creating a desktop.ini file at the specified path"""
        # Construct the folder path
        if current_path == "/" or current_path == "Home":
            folder_path = f"/{folder_name}"
        else:
            folder_path = f"{current_path}/{folder_name}"
        
        # Create desktop.ini file entry
        desktop_ini_path = f"{folder_path}/desktop.ini"
        
        # Check if folder already exists
        existing = self.find_one({"file_name": "desktop.ini", "file_path": desktop_ini_path})
        if existing:
            return False
        
        # Insert desktop.ini file to represent the folder
        self.insert_one({
            "chat_id": 0,  # System-created folder
            "message_id": 0,  # System-created folder
            "thumbnail": None,
            "file_type": "document",
            "file_unique_id": f"folder_{folder_name}_{hash(desktop_ini_path)}",
            "file_size": 0,
            "file_name": "desktop.ini",
            "file_caption": f"Folder: {folder_name}",
            "file_path": desktop_ini_path
        })
        return True