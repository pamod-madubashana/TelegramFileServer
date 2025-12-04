"""
Tests for multi-user access control functionality
"""

import unittest
from unittest.mock import Mock, patch
from bson import ObjectId
from src.Database.Mongodb._files import Files, FileData


class TestMultiUserAccessControl(unittest.TestCase):
    
    def setUp(self):
        """Set up test fixtures before each test method."""
        # Create a mock collection
        self.mock_collection = Mock()
        self.files_db = Files(self.mock_collection)
        
        # Sample file data
        self.sample_file_data = {
            "_id": ObjectId(),
            "chat_id": 123456789,
            "message_id": 987654321,
            "thumbnail": "thumbnail.jpg",
            "file_type": "document",
            "file_unique_id": "unique_file_id_123",
            "file_size": 1024,
            "file_name": "test_document.pdf",
            "file_caption": "Test Document",
            "file_path": "/",
            "owner_id": "123456789"
        }
        
        self.sample_file_data_no_owner = {
            "_id": ObjectId(),
            "chat_id": 123456789,
            "message_id": 987654321,
            "thumbnail": "thumbnail.jpg",
            "file_type": "document",
            "file_unique_id": "unique_file_id_456",
            "file_size": 1024,
            "file_name": "test_document2.pdf",
            "file_caption": "Test Document 2",
            "file_path": "/"
        }

    def test_add_file_with_owner(self):
        """Test adding a file with owner_id"""
        # Call the method
        self.files_db.add_file(
            chat_id=123456789,
            message_id=987654321,
            thumbnail="thumbnail.jpg",
            file_type="document",
            file_unique_id="unique_file_id_123",
            file_size=1024,
            file_name="test_document.pdf",
            file_caption="Test Document",
            file_path="/",
            owner_id="123456789"
        )
        
        # Verify the insert_one method was called with the correct data
        self.mock_collection.insert_one.assert_called_once()
        call_args = self.mock_collection.insert_one.call_args[0][0]
        self.assertEqual(call_args["owner_id"], "user_1")

    def test_add_file_without_owner(self):
        """Test adding a file without owner_id"""
        # Call the method
        self.files_db.add_file(
            chat_id=123456789,
            message_id=987654321,
            thumbnail="thumbnail.jpg",
            file_type="document",
            file_unique_id="unique_file_id_123",
            file_size=1024,
            file_name="test_document.pdf",
            file_caption="Test Document",
            file_path="/"
        )
        
        # Verify the insert_one method was called with the correct data
        self.mock_collection.insert_one.assert_called_once()
        call_args = self.mock_collection.insert_one.call_args[0][0]
        self.assertNotIn("owner_id", call_args)

    def test_get_files_by_path_with_owner_filter(self):
        """Test getting files by path with owner filter"""
        # Mock the find method to return sample data
        self.mock_collection.find.return_value = [self.sample_file_data]
        
        # Call the method
        result = self.files_db.get_files_by_path("/", "123456789")
        
        # Verify the find method was called with the correct query
        self.mock_collection.find.assert_called_once_with({"file_path": "/", "owner_id": "user_1", "$or": [{"file_type": {"$ne": "folder"}}, {"file_type": "folder"}]})
        
        # Verify the result
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].owner_id, "123456789")

    def test_check_file_owner_success(self):
        """Test checking file owner with correct owner"""
        # Mock the find_one method to return sample data
        self.mock_collection.find_one.return_value = self.sample_file_data
        
        # Call the method
        result = self.files_db.check_file_owner(str(self.sample_file_data["_id"]), "123456789")
        
        # Verify the result
        self.assertTrue(result)
        
        # Verify the find_one method was called with the correct query
        self.mock_collection.find_one.assert_called_once_with({
            "_id": self.sample_file_data["_id"], 
            "owner_id": "123456789"
        })

    def test_check_file_owner_failure(self):
        """Test checking file owner with incorrect owner"""
        # Mock the find_one method to return None (file not found for this owner)
        self.mock_collection.find_one.return_value = None
        
        # Call the method
        result = self.files_db.check_file_owner(str(self.sample_file_data["_id"]), "user_2")
        
        # Verify the result
        self.assertFalse(result)
        
        # Verify the find_one method was called with the correct query
        self.mock_collection.find_one.assert_called_once_with({
            "_id": self.sample_file_data["_id"], 
            "owner_id": "user_2"
        })

    def test_rename_file_with_owner_validation(self):
        """Test renaming a file with owner validation"""
        # Mock the find_one method to return sample data
        self.mock_collection.find_one.return_value = self.sample_file_data
        self.mock_collection.update_one.return_value = Mock(modified_count=1)
        
        # Mock the find method for subfolder files
        self.mock_collection.find.return_value = []
        
        # Call the method
        result = self.files_db.rename_file(str(self.sample_file_data["_id"]), "new_name.pdf", "123456789"
        
        # Verify the result
        self.assertTrue(result)
        
        # Verify the find_one method was called with the correct query
        self.mock_collection.find_one.assert_called_once_with({
            "_id": self.sample_file_data["_id"], 
            "owner_id": "user_1"
        })

    def test_rename_file_without_permission(self):
        """Test renaming a file without permission"""
        # Mock the find_one method to return None (no permission)
        self.mock_collection.find_one.return_value = None
        
        # Call the method
        result = self.files_db.rename_file(str(self.sample_file_data["_id"]), "new_name.pdf", "user_2")
        
        # Verify the result
        self.assertFalse(result)
        
        # Verify the find_one method was called with the correct query
        self.mock_collection.find_one.assert_called_once_with({
            "_id": self.sample_file_data["_id"], 
            "owner_id": "user_2"
        })


if __name__ == '__main__':
    unittest.main()