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
    file_type: Literal["document","video","photo","voice","audio","folder"] = None
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

    def add_folder(self, folder_name: str, folder_path: str = "/"):
        """Add a folder entry to the database"""
        # Check if folder already exists
        existing = self.find_one({"file_name": folder_name, "file_path": folder_path, "file_type": "folder"})
        if existing:
            return False
            
        # Generate a unique ID for the folder
        import hashlib
        folder_unique_id = f"folder_{hashlib.md5(f'{folder_path}/{folder_name}'.encode()).hexdigest()}"
            
        # Insert folder entry
        self.insert_one({
            "chat_id": 0,  # System-created folder
            "message_id": 0,  # System-created folder
            "thumbnail": None,
            "file_type": "folder",
            "file_unique_id": folder_unique_id,
            "file_size": 0,
            "file_name": folder_name,
            "file_caption": folder_name,
            "file_path": folder_path
        })
        return True

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
    
    def get_files_by_path(self, path: str = "/"):
        """Get files and folders for a specific path"""
        # Special case: fetch all files (for virtual folders like Images, Documents, etc.)
        if path == "all":
            # Get all files except folders
            files_query = {"file_type": {"$ne": "folder"}}
            all_items = list(self.find(files_query))
        # For root path, get files with path="/" and folders with path="/"
        elif path == "/" or path == "Home":
            # Get root-level files and folders
            files_query = {"file_path": "/", "$or": [{"file_type": {"$ne": "folder"}}, {"file_type": "folder"}]}
            all_items = list(self.find(files_query))
        else:
            # Get files and folders in the specified folder
            # For a path like "/TestFolder", we want files where file_path = "/TestFolder"
            query = {"file_path": path}
            all_items = list(self.find(query))
        
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
            file_path=file.get("file_path", "/")
        ) for file in all_items]
    
    def create_folder(self, folder_name: str, current_path: str = "/"):
        """Create a folder entry in the database"""
        # The folder's path is where it's located, which is the current_path
        # e.g., if we're in "/" and create "TestFolder", the folder's path is "/"
        # if we're in "/TestFolder" and create "SubFolder", the folder's path is "/TestFolder"
        folder_path = current_path
        
        return self.add_folder(folder_name, folder_path)

    def get_file_by_unique_id(self, file_unique_id: str):
        """Get a file by its unique ID"""
        file_data = self.find_one({"file_unique_id": file_unique_id})
        if not file_data:
            return None
        
        return FileData(
            id=file_data.get("_id"), 
            chat_id=file_data.get("chat_id"), 
            message_id=file_data.get("message_id"), 
            file_type=file_data.get("file_type"),
            thumbnail=file_data.get("thumbnail"), 
            file_unique_id=file_data.get("file_unique_id"), 
            file_size=file_data.get("file_size"), 
            file_name=file_data.get("file_name"), 
            file_caption=file_data.get("file_caption"),
            file_path=file_data.get("file_path", "/")
        )