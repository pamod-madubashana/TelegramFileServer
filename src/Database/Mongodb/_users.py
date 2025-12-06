# src/Database/Mongodb/_users.py

from typing import Any, Optional, List
from datetime import datetime
import hashlib

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

    def getTgUser(self, user_id: str) -> Any | None:
        try:return self.find_one({"telegram_user_id": user_id})
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
            
    def get_user_by_identifier(self, user_identifier: str) -> Optional[dict]:
        """
        Get a user by either MongoDB _id or user_id
        Handle special case for admin user with ID "1"
        """
        try:
            # Handle special case for admin user with hardcoded ID "1"
            if user_identifier == "1":
                return self.getUser("admin")
            
            # First try to find by user_id (the username/email identifier)
            user_data = self.find_one({"user_id": user_identifier})
            
            # If that didn't work, try to find by MongoDB _id
            if not user_data:
                try:
                    from bson import ObjectId
                    user_data = self.find_one({"_id": ObjectId(user_identifier)})
                except Exception:
                    # If ObjectId conversion fails, return None
                    pass
            
            return user_data
        except Exception as e:
            logger.error(f"Error retrieving user with identifier {user_identifier}: {e}")
            return None
            
    def delete_user(self, user_identifier: str) -> bool:
        """
        Delete a user by either MongoDB _id or user_id
        Handle special case for admin user with ID "1"
        """
        try:
            # Handle special case for admin user with hardcoded ID "1"
            if user_identifier == "1":
                # Prevent deletion of admin user
                logger.info("Attempt to delete admin user by ID '1' denied")
                return False
            
            # First try to delete by user_id (the username/email identifier)
            result = self.delete_one({"user_id": user_identifier})
            
            # If that didn't work, try to delete by MongoDB _id
            if result.deleted_count == 0:
                try:
                    from bson import ObjectId
                    result = self.delete_one({"_id": ObjectId(user_identifier)})
                except Exception:
                    # If ObjectId conversion fails, we stick with the previous result
                    pass
            
            logger.info(f"Deleted user with identifier {user_identifier}")
            return result.deleted_count > 0
        except Exception as e:
            logger.error(f"Error deleting user with identifier {user_identifier}: {e}")
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
            
    def verify_user_credentials(self, username: str, password: str) -> bool:
        """
        Verify user credentials against database
        If no password hash exists, allow login with default password and save hash
        """
        try:
            # Get user from database
            user_data = self.getUser(username)
            if not user_data:
                logger.info(f"User {username} not found in database")
                return False
            
            # Get stored password hash
            stored_hash = user_data.get('password_hash')
            
            # If no password hash exists, check if password matches default
            if not stored_hash:
                logger.info(f"No password hash found for user {username}")
                # Check if password matches default password
                DEFAULT_PASSWORD = "password"
                if password == DEFAULT_PASSWORD:
                    logger.info(f"Using default password for user {username}")
                    # Save the password hash for future logins
                    password_hash = hashlib.sha256(password.encode()).hexdigest()
                    self.update_one(
                        {"user_id": username},
                        {"$set": {"password_hash": password_hash}}
                    )
                    logger.info(f"Saved password hash for user {username}")
                    return True
                else:
                    logger.info(f"Password does not match default for user {username}")
                    return False
            
            # Hash the provided password
            provided_hash = hashlib.sha256(password.encode()).hexdigest()
            
            # Compare hashes
            is_valid = stored_hash == provided_hash
            logger.info(f"Password verification for user {username}: {is_valid}")
            return is_valid
        except Exception as e:
            logger.error(f"Error verifying credentials for user {username}: {e}")
            return False
            
    def verify_current_password(self, username: str, password: str) -> bool:
        """
        Verify current password without automatically saving hash
        Used for password change operations
        """
        try:
            # Get user from database
            user_data = self.getUser(username)
            if not user_data:
                logger.info(f"User {username} not found in database")
                return False
            
            # Get stored password hash
            stored_hash = user_data.get('password_hash')
            
            # If no password hash exists, check if password matches default
            if not stored_hash:
                logger.info(f"No password hash found for user {username}")
                # Check if password matches default password
                DEFAULT_PASSWORD = "password"
                return password == DEFAULT_PASSWORD
            
            # Hash the provided password
            provided_hash = hashlib.sha256(password.encode()).hexdigest()
            
            # Compare hashes
            is_valid = stored_hash == provided_hash
            logger.info(f"Current password verification for user {username}: {is_valid}")
            return is_valid
        except Exception as e:
            logger.error(f"Error verifying current password for user {username}: {e}")
            return False

    def update_user_by_identifier(self, user_identifier: str, update_data: dict) -> bool:
        """
        Update a user by either MongoDB _id or user_id
        Handle special case for admin user with ID "1"
        """
        try:
            # Handle special case for admin user with hardcoded ID "1"
            if user_identifier == "1":
                user_identifier = "admin"
            
            # First try to update by user_id (the username/email identifier)
            result = self.update_one({"user_id": user_identifier}, {"$set": update_data})
            
            # If that didn't work, try to update by MongoDB _id
            if result.matched_count == 0:
                try:
                    from bson import ObjectId
                    result = self.update_one({"_id": ObjectId(user_identifier)}, {"$set": update_data})
                except Exception:
                    # If ObjectId conversion fails, we stick with the previous result
                    pass
            
            logger.info(f"Updated user with identifier {user_identifier}")
            return result.matched_count > 0
        except Exception as e:
            logger.error(f"Error updating user with identifier {user_identifier}: {e}")
            return False
