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

    def getUser(self, username: str) -> Any | None:
        """Get user by username, with backward compatibility for old user_id field"""
        try:
            # First try to find by username (new structure)
            user_data = self.find_one({"username": username})
            
            # If not found, try to find by user_id (old structure) for backward compatibility
            if not user_data:
                user_data = self.find_one({"user_id": username})
                # If found with old structure, update to new structure
                if user_data:
                    # Update the document to use the new structure
                    self.update_one(
                        {"_id": user_data["_id"]},
                        {"$rename": {"user_id": "username"}}
                    )
                    # Refresh the user_data with the updated document
                    user_data = self.find_one({"_id": user_data["_id"]})
            
            return user_data
        except:
            return None

    def getTgUser(self, telegram_user_id: str) -> Any | None:
        """Get user by Telegram user ID"""
        try:return self.find_one({"telegram_user_id": telegram_user_id})
        except:return None

    def getUserById(self, user_id: str) -> Any | None:
        """Get user by database user_id"""
        try:
            from bson import ObjectId
            return self.find_one({"_id": ObjectId(user_id)})
        except:
            return None

    def SaveUser(self, username: str, user_id: str = None, password_hash: Optional[str] = None, email: Optional[str] = None) -> InsertOneResult | None:
        """
        Save a new user to the database
        If user_id is provided, use it as the database _id, otherwise let MongoDB generate one
        """
        try:
            if username in self.user_cache:return
            self.user_cache.add(username)
            
            # Check if user already exists (with either new or old structure)
            saved = self.getUser(username)
            
            # If user doesn't exist, create new user
            if not saved:
                user_data = {'username': username}
                # Add user_id if provided
                if user_id:
                    from bson import ObjectId
                    user_data['_id'] = ObjectId(user_id)
                if password_hash:
                    user_data['password_hash'] = password_hash
                if email:
                    user_data['email'] = email
                return self.insert_one(user_data)
            
        except:return None
        
    def saveUserSetting(self, username: str, setting: str, value: str) -> None:
        try:
            if (self.getUser(username)):
                self.update_one({'username': username}, {"$set": {setting: value}})
            else:
                self.insert_one({'username': username, setting: value})
        except:return None
        
    def save_password_hash(self, username: str, password_hash: str) -> None:
        """Save user's password hash"""
        self.saveUserSetting(username, 'password_hash', password_hash)
        
    def save_email(self, username: str, email: str) -> None:
        """Save user's email"""
        self.saveUserSetting(username, 'email', email)

    def getUserSetting(self, username: str, setting: str, default: str = None) -> Any | None:
        try:
            if (saved := self.getUser(username)):
                return saved[setting]
            else:
                self.insert_one({'username': username, setting: default})
        except:return None
        
    def get_password_hash(self, username: str) -> Optional[str]:
        """Get user's password hash"""
        user_data = self.getUser(username)
        return user_data.get('password_hash') if user_data else None
        
    def get_email(self, username: str) -> Optional[str]:
        """Get user's email"""
        user_data = self.getUser(username)
        return user_data.get('email') if user_data else None
        
    def update_telegram_info(self, username: str, telegram_data: dict) -> bool:
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
                {'username': username},
                {"$set": update_data},
                upsert=True
            )
            
            logger.info(f"Updated Telegram info for user {username}")
            return result.modified_count > 0 or result.upserted_id is not None
        except Exception as e:
            logger.error(f"Error updating Telegram info for user {username}: {e}")
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
        Get a user by either database _id, username, or Telegram user ID
        Handle special case for admin user with ID "1"
        """
        try:
            # Handle special case for admin user with hardcoded ID "1"
            if user_identifier == "1":
                return self.getUser("admin")
            
            # First try to find by username
            user_data = self.find_one({"username": user_identifier})
            
            # If that didn't work, try to find by database _id
            if not user_data:
                try:
                    from bson import ObjectId
                    user_data = self.find_one({"_id": ObjectId(user_identifier)})
                except Exception:
                    # If ObjectId conversion fails, try Telegram user ID
                    try:
                        user_data = self.find_one({"telegram_user_id": int(user_identifier)})
                    except Exception:
                        # If all methods fail, return None
                        pass
            
            return user_data
        except Exception as e:
            logger.error(f"Error retrieving user with identifier {user_identifier}: {e}")
            return None
            
    def delete_user(self, user_identifier: str) -> bool:
        """
        Delete a user by either database _id, username, or Telegram user ID
        Handle special case for admin user with ID "1"
        """
        try:
            # Handle special case for admin user with hardcoded ID "1"
            if user_identifier == "1":
                # Prevent deletion of admin user
                logger.info("Attempt to delete admin user by ID '1' denied")
                return False
            
            # First try to delete by username
            result = self.delete_one({"username": user_identifier})
            
            # If that didn't work, try to delete by database _id
            if result.deleted_count == 0:
                try:
                    from bson import ObjectId
                    result = self.delete_one({"_id": ObjectId(user_identifier)})
                except Exception:
                    # If ObjectId conversion fails, try Telegram user ID
                    try:
                        result = self.delete_one({"telegram_user_id": int(user_identifier)})
                    except Exception:
                        # If all methods fail, we stick with the previous result
                        pass
            
            logger.info(f"Deleted user with identifier {user_identifier}")
            return result.deleted_count > 0
        except Exception as e:
            logger.error(f"Error deleting user with identifier {user_identifier}: {e}")
            return False
            
    def get_all_users(self) -> List[dict]:
        """
        Get all users from the database
        Migrate old user_id fields to username fields for backward compatibility
        """
        try:
            users = list(self.find())
            
            # Check if any users still have the old user_id field and migrate them
            for user in users:
                if "user_id" in user and "username" not in user:
                    # Update the document to use the new structure
                    self.update_one(
                        {"_id": user["_id"]},
                        {"$rename": {"user_id": "username"}}
                    )
                    # Update the user object in the list
                    user["username"] = user.pop("user_id")
            
            return users
        except Exception as e:
            logger.error(f"Error retrieving all users: {e}")
            return []
            
    def update_permissions(self, username: str, permissions: dict) -> bool:
        """
        Update user's permissions
        """
        try:
            # Store permissions in the database
            result = self.update_one(
                {'username': username},
                {"$set": {"permissions": permissions}}
            )
            logger.info(f"Updated permissions for user {username}: {permissions}")
            return result.modified_count > 0
        except Exception as e:
            logger.error(f"Error updating permissions for user {username}: {e}")
            return False
            
    def get_permissions(self, username: str) -> Optional[dict]:
        """
        Get user's permissions
        """
        try:
            user_data = self.getUser(username)
            return user_data.get('permissions') if user_data else None
        except Exception as e:
            logger.error(f"Error retrieving permissions for user {username}: {e}")
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
                        {"username": username},
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
        Update a user by either database _id, username, or Telegram user ID
        Handle special case for admin user with ID "1"
        """
        try:
            # Handle special case for admin user with hardcoded ID "1"
            if user_identifier == "1":
                user_identifier = "admin"
            
            # First try to update by username
            result = self.update_one({"username": user_identifier}, {"$set": update_data})
            
            # If that didn't work, try to update by database _id
            if result.matched_count == 0:
                try:
                    from bson import ObjectId
                    result = self.update_one({"_id": ObjectId(user_identifier)}, {"$set": update_data})
                except Exception:
                    # If ObjectId conversion fails, try Telegram user ID
                    try:
                        result = self.update_one({"telegram_user_id": int(user_identifier)}, {"$set": update_data})
                    except Exception:
                        # If all methods fail, we stick with the previous result
                        pass
            
            logger.info(f"Updated user with identifier {user_identifier}")
            return result.matched_count > 0
        except Exception as e:
            logger.error(f"Error updating user with identifier {user_identifier}: {e}")
            return False

    def save_auth_token(self, username: str, auth_token: str, auth_method: str) -> None:
        """Save an auth token for a user"""
        try:
            # Save token with user info and expiration time (24 hours from now)
            from datetime import datetime, timedelta
            expires_at = datetime.now() + timedelta(hours=24)
            
            token_data = {
                'username': username,
                'auth_token': auth_token,
                'auth_method': auth_method,
                'created_at': datetime.now(),
                'expires_at': expires_at
            }
            
            # Use upsert to either insert new or update existing token
            self.database.AuthTokens.update_one(
                {'auth_token': auth_token},
                {'$set': token_data},
                upsert=True
            )
            logger.info(f"Saved auth token for user {username}")
        except Exception as e:
            logger.error(f"Failed to save auth token for user {username}: {e}")

    def get_auth_token(self, auth_token: str) -> dict:
        """Retrieve an auth token data"""
        try:
            from datetime import datetime
            # Find token and check if it's expired
            token_data = self.database.AuthTokens.find_one({'auth_token': auth_token})
            if token_data:
                # Check if token is expired
                if token_data.get('expires_at') and token_data['expires_at'] < datetime.now():
                    # Token expired, remove it
                    self.database.AuthTokens.delete_one({'auth_token': auth_token})
                    return None
                return token_data
            return None
        except Exception as e:
            logger.error(f"Failed to retrieve auth token {auth_token}: {e}")
            return None

    def remove_auth_token(self, auth_token: str) -> None:
        """Remove an auth token"""
        try:
            self.database.AuthTokens.delete_one({'auth_token': auth_token})
            logger.info(f"Removed auth token")
        except Exception as e:
            logger.error(f"Failed to remove auth token: {e}")

    def cleanup_expired_tokens(self) -> None:
        """Remove all expired tokens"""
        try:
            from datetime import datetime
            result = self.database.AuthTokens.delete_many({'expires_at': {'$lt': datetime.now()}})
            if result.deleted_count > 0:
                logger.info(f"Cleaned up {result.deleted_count} expired auth tokens")
        except Exception as e:
            logger.error(f"Failed to cleanup expired auth tokens: {e}")
