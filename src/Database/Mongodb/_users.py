# src/Database/Mongodb/_users.py

from typing import Any, Optional, List
from datetime import datetime

from d4rk.Logs import setup_logger

from pymongo.collection import Collection
from pymongo.results import InsertOneResult

logger = setup_logger(__name__)

class Users(Collection):
    user_cache = set()
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

    def get_user_count(self) -> int:
        try:return self.count_documents()
        except:return 0

    def getUser(self, user_id: str) -> Any | None:
        try:return self.find_one({"user_id": user_id})
        except:return None
            
    def SaveUser(self, user_id: str, password_hash: Optional[str] = None, email: Optional[str] = None) -> InsertOneResult | None:
        try:
            if user_id in self.user_cache:return
            self.user_cache.add(user_id)
            saved = self.getUser(user_id)
            if not saved:
                user_data = {'user_id': user_id}
                if password_hash:
                    user_data['password_hash'] = password_hash
                if email:
                    user_data['email'] = email
                return self.insert_one(user_data)
            
        except:return None
        
    def saveUserSetting(self,user_id,setting :str,value :str) -> None:
        try:
            if (self.getUser(user_id)):
                self.update_one({'user_id':user_id},{"$set": {setting: value}})
            else:
                self.insert_one({'user_id':user_id,setting:value})
        except:return None
        
    def save_password_hash(self, user_id: str, password_hash: str) -> None:
        """Save user's password hash"""
        self.saveUserSetting(user_id, 'password_hash', password_hash)
        
    def save_email(self, user_id: str, email: str) -> None:
        """Save user's email"""
        self.saveUserSetting(user_id, 'email', email)

    def getUserSetting(self,user_id :str, setting :str,default :str = None) -> Any | None:
        try:
            if (saved:=self.getUser(user_id)):
                return saved[setting]
            else:
                self.insert_one({'user_id':user_id,setting:default})
        except:return None
        
    def get_password_hash(self, user_id: str) -> Optional[str]:
        """Get user's password hash"""
        user_data = self.getUser(user_id)
        return user_data.get('password_hash') if user_data else None
        
    def get_email(self, user_id: str) -> Optional[str]:
        """Get user's email"""
        user_data = self.getUser(user_id)
        return user_data.get('email') if user_data else None
        
    def update_telegram_info(self, user_id: str, telegram_data: dict) -> bool:
        """
        Update user's Telegram information
        """
        try:
            update_data = {
                "telegram_user_id": telegram_data.get("telegram_user_id"),
                "telegram_username": telegram_data.get("telegram_username"),
                "telegram_first_name": telegram_data.get("telegram_first_name"),
                "telegram_last_name": telegram_data.get("telegram_last_name"),
                "telegram_profile_picture": telegram_data.get("telegram_profile_picture"),
                "updated_at": datetime.utcnow()
            }
            
            result = self.update_one(
                {'user_id': user_id},
                {"$set": update_data},
                upsert=True
            )
            
            logger.info(f"Updated Telegram info for user {user_id}")
            return result.modified_count > 0 or result.upserted_id is not None
        except Exception as e:
            logger.error(f"Error updating Telegram info for user {user_id}: {e}")
            return False
            
    def get_user_by_telegram_id(self, telegram_user_id: int) -> Optional[dict]:
        """
        Get user by Telegram user ID
        """
        try:
            return self.find_one({"telegram_user_id": telegram_user_id})
        except Exception as e:
            logger.error(f"Error retrieving user by Telegram ID {telegram_user_id}: {e}")
            return None
            
    def delete_user(self, user_id: str) -> bool:
        """
        Delete a user by user_id
        """
        try:
            result = self.delete_one({"user_id": user_id})
            logger.info(f"Deleted user {user_id}")
            return result.deleted_count > 0
        except Exception as e:
            logger.error(f"Error deleting user {user_id}: {e}")
            return False
            
    def get_all_users(self) -> List[dict]:
        """
        Get all users from the database
        """
        try:
            return list(self.find())
        except Exception as e:
            logger.error(f"Error retrieving all users: {e}")
            return []
            
    def update_permissions(self, user_id: str, permissions: dict) -> bool:
        """
        Update user's permissions
        """
        try:
            # Store permissions in the database
            result = self.update_one(
                {'user_id': user_id},
                {"$set": {"permissions": permissions}}
            )
            logger.info(f"Updated permissions for user {user_id}: {permissions}")
            return result.modified_count > 0
        except Exception as e:
            logger.error(f"Error updating permissions for user {user_id}: {e}")
            return False
            
    def get_permissions(self, user_id: str) -> Optional[dict]:
        """
        Get user's permissions
        """
        try:
            user_data = self.getUser(user_id)
            return user_data.get('permissions') if user_data else None
        except Exception as e:
            logger.error(f"Error retrieving permissions for user {user_id}: {e}")
            return None