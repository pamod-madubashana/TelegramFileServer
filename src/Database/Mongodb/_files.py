# src/Database/Mongodb/_settings.py

from typing import Any, Literal
from dataclasses import dataclass
from d4rk.Logs import setup_logger

from pymongo.collection import Collection
from pymongo.results import InsertOneResult, UpdateResult

logger = setup_logger(__name__)


@dataclass
class FileData:
    chat_id: int
    message_id: int
    file_unique_id: str = None
    file_size: int = None
    file_name: str|None = None
    file_caption: str = None
    
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
