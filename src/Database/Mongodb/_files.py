# src/Database/Mongodb/_files.py

from typing import Any, Literal
from dataclasses import dataclass
from d4rk.Logs import setup_logger
from datetime import datetime

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
    owner_id: str = None  # Owner user ID for multi-user support
    modified_date: str = None  # ISO format date string for when file was last modified
    
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
    
    def add_file(self, chat_id: int, message_id: int, thumbnail: str, file_type: str, file_unique_id: str, file_size: int, file_name: str, file_caption: str, file_path: str = "/", owner_id: str = None, modified_date: str = None):
        saved = self.check_if_exists(chat_id, message_id, file_unique_id)
        if not saved:
            file_doc = {
                "chat_id": chat_id,
                "message_id": message_id,
                "thumbnail": thumbnail,
                "file_type": file_type,
                "file_unique_id": file_unique_id,
                "file_size": file_size,
                "file_name": file_name,
                "file_caption": file_caption,
                "file_path": file_path,  # Store file path
                "modified_date": modified_date or datetime.utcnow().isoformat()  # Set current time if not provided
            }
            
            # Add owner_id if provided
            if owner_id:
                file_doc["owner_id"] = owner_id
            
            self.insert_one(file_doc)
            return True
        return None

    def add_folder(self, folder_name: str, folder_path: str = "/", owner_id: str = None):
        """Add a folder entry to the database"""
        # Log the parameters for debugging
        logger.info(f"add_folder called with folder_name='{folder_name}', folder_path='{folder_path}', owner_id='{owner_id}'")
        
        # Ensure folder_path is not empty
        if not folder_path:
            folder_path = "/"
            
        # Check if folder already exists
        query = {"file_name": folder_name, "file_path": folder_path, "file_type": "folder"}
        # Include owner_id in query if provided
        if owner_id:
            query["owner_id"] = owner_id
        elif "owner_id" not in query:
            query["owner_id"] = {"$exists": False}
            
        existing = self.find_one(query)
        if existing:
            logger.info(f"Folder '{folder_name}' already exists at path '{folder_path}'")
            return False
            
        # Generate a unique ID for the folder
        import hashlib
        folder_unique_id = f"folder_{hashlib.md5(f'{folder_path}/{folder_name}'.encode()).hexdigest()}"
            
        # Insert folder entry
        folder_doc = {
            "chat_id": 0,  # System-created folder
            "message_id": 0,  # System-created folder
            "thumbnail": None,
            "file_type": "folder",
            "file_unique_id": folder_unique_id,
            "file_size": 0,
            "file_name": folder_name,
            "file_caption": folder_name,
            "file_path": folder_path,
            "modified_date": datetime.utcnow().isoformat()  # Set current time for folder creation
        }
        
        # Add owner_id if provided
        if owner_id:
            folder_doc["owner_id"] = owner_id
            
        logger.info(f"Inserting folder document: {folder_doc}")
        self.insert_one(folder_doc)
        return True

    def create_default_folders(self, owner_id: str = None):
        """Create default folders for a user when they log in"""
        default_folders = ["Images", "Documents", "Videos", "Audio", "Voice Messages"]
        created_folders = []
        
        for folder_name in default_folders:
            # Check if folder already exists
            query = {"file_name": folder_name, "file_path": "/Home", "file_type": "folder"}
            if owner_id:
                query["owner_id"] = owner_id
            existing_folder = self.find_one(query)
            
            if not existing_folder:
                # Create the default folder
                success = self.add_folder(folder_name, "/Home", owner_id)
                if success:
                    created_folders.append(folder_name)
        
        if created_folders:
            logger.info(f"Created default folders for user {owner_id}: {created_folders}")
        else:
            logger.info(f"Default folders already exist for user {owner_id}")
        
        return created_folders
    
    def create_folder_path(self, full_path: str, owner_id: str = None):
        """Recursively create folder structure for a given path"""
        # Log the parameters for debugging
        logger.info(f"create_folder_path called with full_path='{full_path}', owner_id='{owner_id}'")
        
        # Normalize the path
        full_path = full_path.rstrip('/')
        if not full_path or full_path == '/':
            logger.info("Empty or root path, returning True")
            return True
            
        # Split path into components
        path_parts = full_path.lstrip('/').split('/')
        logger.info(f"Path parts: {path_parts}")
        
        # Create each folder in the path
        current_path = "/"
        for i, folder_name in enumerate(path_parts):
            if folder_name:  # Skip empty parts
                logger.info(f"Creating folder '{folder_name}' at path '{current_path}'")
                # The folder's path should be the parent path, not the current path
                # For example, for "/qwes", we create folder "qwes" with path "/"
                success = self.add_folder(folder_name, current_path, owner_id)
                # Update current_path for next iteration
                if current_path == "/":
                    current_path = f"/{folder_name}"
                else:
                    current_path = f"{current_path}/{folder_name}"
                logger.info(f"Updated current_path to '{current_path}'")
                    
        return True

    def get_all_files(self, owner_id: str = None):
        # Filter by owner_id if provided
        query = {}
        if owner_id:
            query["owner_id"] = owner_id
        
        files = self.find(query)
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
            file_path=file.get("file_path", "/"),  # Default to root if not set
            owner_id=file.get("owner_id"),
            modified_date=file.get("modified_date")
            ) for file in files]
    
    def get_files_by_path(self, path: str = "/", owner_id: str = None):
        """Get files and folders for a specific path"""
        # Build query with owner filter
        def build_query(base_query):
            if owner_id:
                base_query["owner_id"] = owner_id
            return base_query
        
        # Special case: fetch all files (for virtual folders like Images, Documents, etc.)
        if path == "all":
            # Get all files except folders
            files_query = build_query({"file_type": {"$ne": "folder"}})
            all_items = list(self.find(files_query))
        # For root path, get files with path="/" and folders with path="/"
        elif path == "/" or path == "Home":
            # Get root-level files and folders
            files_query = build_query({"file_path": "/Home"})
            all_items = list(self.find(files_query))
        else:
            # Get files and folders in the specified folder
            # For a path like "/TestFolder", we want files where file_path = "/TestFolder"
            base_query = {"file_path": path}
            query = build_query(base_query)
            logger.info(f"Executing file query: {query}")
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
            file_path=file.get("file_path", "/"),
            owner_id=file.get("owner_id"),
            modified_date=file.get("modified_date")
        ) for file in all_items]
    
    def create_folder(self, folder_name: str, current_path: str = "/", owner_id: str = None):
        """Create a folder entry in the database"""
        # The folder's path is where it's located, which is the current_path
        # e.g., if we're in "/" and create "TestFolder", the folder's path is "/"
        # if we're in "/TestFolder" and create "SubFolder", the folder's path is "/TestFolder"
        folder_path = current_path
        
        return self.add_folder(folder_name, folder_path, owner_id)

    def get_file_by_unique_id(self, file_unique_id: str, owner_id: str = None):
        """Get a file by its unique ID"""
        # Build query with owner filter
        query = {"file_unique_id": file_unique_id}
        if owner_id:
            query["owner_id"] = owner_id
            
        file_data = self.find_one(query)
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
            file_path=file_data.get("file_path", "/"),
            owner_id=file_data.get("owner_id"),
            modified_date=file_data.get("modified_date")
        )

    def check_file_owner(self, file_id: str, owner_id: str) -> bool:
        """Check if a user owns a file or folder"""
        from bson import ObjectId
        
        # Build query with owner filter
        query = {"_id": ObjectId(file_id), "owner_id": owner_id}
        file_data = self.find_one(query)
        return file_data is not None
    
    def check_file_owner_by_unique_id(self, file_unique_id: str, owner_id: str) -> bool:
        """Check if a user owns a file or folder by its unique ID"""
        # Build query with owner filter
        query = {"file_unique_id": file_unique_id, "owner_id": owner_id}
        file_data = self.find_one(query)
        return file_data is not None
    
    def rename_file(self, file_id: str, new_name: str, owner_id: str = None) -> bool:
        """Rename a file or folder"""
        from bson import ObjectId
        
        # Build query with owner filter
        query = {"_id": ObjectId(file_id)}
        if owner_id:
            query["owner_id"] = owner_id
            
        # Find the file/folder by ID
        file_data = self.find_one(query)
        if not file_data:
            return False
            
        # Update the file/folder name and modified date
        result = self.update_one(
            query,
            {"$set": {"file_name": new_name, "modified_date": datetime.utcnow().isoformat()}}
        )
        
        # If this is a folder, we need to update the paths of all contained files
        if file_data.get("file_type") == "folder":
            old_path = file_data.get("file_path", "/")
            folder_name = file_data.get("file_name", "")
            
            # Construct the old full path and new full path
            # The folder's full path is its parent path + "/" + folder name
            if old_path == "/":
                old_full_path = f"/{folder_name}"
            else:
                old_full_path = f"{old_path}/{folder_name}"
                
            # For the new path, we keep the same parent path but change the folder name
            if old_path == "/":
                new_full_path = f"/{new_name}"
            else:
                new_full_path = f"{old_path}/{new_name}"
            
            # Update all files that are directly in this folder (with owner filter)
            folder_update_query = {"file_path": old_full_path}
            if owner_id:
                folder_update_query["owner_id"] = owner_id
                
            self.update_many(
                folder_update_query,
                {"$set": {"file_path": new_full_path, "modified_date": datetime.utcnow().isoformat()}}
            )
            
            # Update files in subfolders (paths that start with old_full_path + "/")
            import re
            regex_pattern = f"^{re.escape(old_full_path)}/"
            
            # Find all files with paths starting with old_full_path + "/" (with owner filter)
            subfolder_query = {"file_path": {"$regex": regex_pattern}}
            if owner_id:
                subfolder_query["owner_id"] = owner_id
                
            subfolder_files = self.find(subfolder_query)
            for file in subfolder_files:
                new_file_path = file["file_path"].replace(old_full_path, new_full_path, 1)
                self.update_one(
                    {"_id": file["_id"]},
                    {"$set": {"file_path": new_file_path, "modified_date": datetime.utcnow().isoformat()}}
                )
        
        return result.modified_count > 0
