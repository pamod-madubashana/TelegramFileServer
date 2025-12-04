"""
Tests for web API endpoints with multi-user access control
"""

import unittest
from unittest.mock import Mock, patch
from fastapi.testclient import TestClient
from src.Backend.routes.web import app


class TestWebEndpoints(unittest.TestCase):
    
    def setUp(self):
        """Set up test fixtures before each test method."""
        self.client = TestClient(app)
        
        # Mock database
        self.mock_database = Mock()
        self.mock_files_collection = Mock()
        self.mock_database.Files = self.mock_files_collection
        
        # Patch the database in the web module
        self.database_patch = patch('src.Backend.routes.web.database', self.mock_database)
        self.database_patch.start()
        
        # Sample file data
        self.sample_file_data = {
            "_id": "507f1f77bcf86cd799439011",
            "chat_id": 123456789,
            "message_id": 987654321,
            "thumbnail": "thumbnail.jpg",
            "file_type": "document",
            "file_unique_id": "unique_file_id_123",
            "file_size": 1024,
            "file_name": "test_document.pdf",
            "file_caption": "Test Document",
            "file_path": "/",
            "owner_id": "user_1"
        }

    def tearDown(self):
        """Clean up after each test method."""
        self.database_patch.stop()

    @patch('src.Backend.routes.web.require_auth')
    def test_get_files_with_owner_filter(self, mock_require_auth):
        """Test getting files with owner filter"""
        # Mock authentication to return user ID
        mock_require_auth.return_value = "user_1"
        
        # Mock database response
        self.mock_files_collection.get_files_by_path.return_value = [Mock()]
        
        # Make request
        response = self.client.get("/api/files?path=/", headers={"Cookie": "session=test"})
        
        # Verify response
        self.assertEqual(response.status_code, 200)
        
        # Verify database method was called with owner ID
        self.mock_files_collection.get_files_by_path.assert_called_once_with("/", "user_1")

    @patch('src.Backend.routes.web.require_auth')
    def test_create_folder_with_owner(self, mock_require_auth):
        """Test creating folder with owner"""
        # Mock authentication to return user ID
        mock_require_auth.return_value = "user_1"
        
        # Mock database response
        self.mock_files_collection.create_folder.return_value = True
        
        # Make request
        response = self.client.post(
            "/api/folders/create",
            json={"folderName": "test_folder", "currentPath": "/"},
            headers={"Cookie": "session=test"}
        )
        
        # Verify response
        self.assertEqual(response.status_code, 200)
        
        # Verify database method was called with owner ID
        self.mock_files_collection.create_folder.assert_called_once_with("test_folder", "/", "user_1")

    @patch('src.Backend.routes.web.require_auth')
    def test_move_file_with_owner_validation(self, mock_require_auth):
        """Test moving file with owner validation"""
        # Mock authentication to return user ID
        mock_require_auth.return_value = "user_1"
        
        # Mock database responses
        self.mock_files_collection.check_file_owner.return_value = True
        self.mock_files_collection.find_one.return_value = self.sample_file_data
        self.mock_files_collection.update_one.return_value = Mock()
        
        # Make request
        response = self.client.post(
            "/api/files/move",
            json={"file_id": "507f1f77bcf86cd799439011", "target_path": "/new_path"},
            headers={"Cookie": "session=test"}
        )
        
        # Verify response
        self.assertEqual(response.status_code, 200)
        
        # Verify owner validation was called
        self.mock_files_collection.check_file_owner.assert_called_once_with("507f1f77bcf86cd799439011", "user_1")
        
        # Verify update was called with owner filter
        self.mock_files_collection.update_one.assert_called_once_with(
            {"_id": "507f1f77bcf86cd799439011", "owner_id": "user_1"},
            {"$set": {"file_path": "/new_path"}}
        )

    @patch('src.Backend.routes.web.require_auth')
    def test_move_file_without_permission(self, mock_require_auth):
        """Test moving file without permission"""
        # Mock authentication to return user ID
        mock_require_auth.return_value = "user_2"  # Different user
        
        # Mock database responses - user doesn't own the file
        self.mock_files_collection.check_file_owner.return_value = False
        
        # Make request
        response = self.client.post(
            "/api/files/move",
            json={"file_id": "507f1f77bcf86cd799439011", "target_path": "/new_path"},
            headers={"Cookie": "session=test"}
        )
        
        # Verify response - should be forbidden
        self.assertEqual(response.status_code, 403)
        
        # Verify owner validation was called
        self.mock_files_collection.check_file_owner.assert_called_once_with("507f1f77bcf86cd799439011", "user_2")

    @patch('src.Backend.routes.web.require_auth')
    def test_delete_file_with_owner_validation(self, mock_require_auth):
        """Test deleting file with owner validation"""
        # Mock authentication to return user ID
        mock_require_auth.return_value = "user_1"
        
        # Mock database responses
        self.mock_files_collection.check_file_owner.return_value = True
        self.mock_files_collection.find_one.return_value = self.sample_file_data
        self.mock_files_collection.delete_one.return_value = Mock(deleted_count=1)
        
        # Make request
        response = self.client.post(
            "/api/files/delete",
            json={"file_id": "507f1f77bcf86cd799439011"},
            headers={"Cookie": "session=test"}
        )
        
        # Verify response
        self.assertEqual(response.status_code, 200)
        
        # Verify owner validation was called
        self.mock_files_collection.check_file_owner.assert_called_once_with("507f1f77bcf86cd799439011", "user_1")
        
        # Verify delete was called with owner filter
        self.mock_files_collection.delete_one.assert_called_once_with(
            {"_id": "507f1f77bcf86cd799439011", "owner_id": "user_1"}
        )

    @patch('src.Backend.routes.web.require_auth')
    def test_rename_file_with_owner_validation(self, mock_require_auth):
        """Test renaming file with owner validation"""
        # Mock authentication to return user ID
        mock_require_auth.return_value = "user_1"
        
        # Mock database responses
        self.mock_files_collection.rename_file.return_value = True
        
        # Make request
        response = self.client.post(
            "/api/files/rename",
            json={"file_id": "507f1f77bcf86cd799439011", "new_name": "new_name.pdf"},
            headers={"Cookie": "session=test"}
        )
        
        # Verify response
        self.assertEqual(response.status_code, 200)
        
        # Verify rename was called with owner ID
        self.mock_files_collection.rename_file.assert_called_once_with(
            "507f1f77bcf86cd799439011", "new_name.pdf", "user_1"
        )


if __name__ == '__main__':
    unittest.main()