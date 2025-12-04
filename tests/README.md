# Tests for Multi-User Access Control

This directory contains tests for the multi-user access control functionality implemented in the Telegram File Server.

## Test Files

1. `test_multi_user_access.py` - Tests for the database layer functionality
2. `test_web_endpoints.py` - Tests for the web API endpoints

## Running Tests

To run the tests, use the following command from the project root directory:

```bash
python -m pytest tests/
```

Or to run a specific test file:

```bash
python -m pytest tests/test_multi_user_access.py
python -m pytest tests/test_web_endpoints.py
```

## Test Coverage

The tests cover the following functionality:

### Database Layer
- Adding files with owner information
- Retrieving files filtered by owner
- Validating file ownership for operations
- Renaming files with owner validation

### Web API Endpoints
- File listing with owner filtering
- Folder creation with owner assignment
- File operations (move, copy, delete, rename) with owner validation
- Access control enforcement (403 Forbidden responses for unauthorized access)