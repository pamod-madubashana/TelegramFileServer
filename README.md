# Telegram File Server

Telegram File Server is a powerful, self-hosted media server application that integrates with Telegram bots to provide file storage, organization, and streaming capabilities through a web interface. It now supports multi-user access with per-file ownership and access control.

## Features

- **Telegram Integration**: Uses Pyrogram to connect with Telegram bots for file management
- **Web Interface**: Modern React frontend with TypeScript and TailwindCSS
- **File Management**: Organize files in folders, search, and filter by type
- **Media Streaming**: Built-in support for streaming videos, images, documents, and audio
- **Authentication**: Secure login with local accounts or Google OAuth
- **Multi-User Support**: Per-file ownership and access control
- **Database Storage**: MongoDB integration for storing file metadata
- **Auto Updates**: GitHub webhook support for automatic deployment updates
- **Multi-Bot Support**: Manage multiple Telegram bots from a single interface

## Architecture

The application consists of three main components:

1. **Backend Server** (FastAPI):
   - REST API for file operations
   - Telegram bot management
   - Authentication system
   - MongoDB integration

2. **Frontend Interface** (React/Vite):
   - File explorer UI with grid/list views
   - Folder navigation and breadcrumb support
   - File operations (copy, move, delete, rename)
   - Responsive design with dark/light mode

3. **Telegram Bots** (Pyrogram):
   - File upload/download from Telegram
   - Media organization and categorization
   - User interaction through commands

## Frontend Repository

The frontend is maintained as a separate repository and included in this project as a git submodule:
- Repository: https://github.com/pamod-madubashana/FileServerApp
- Location: `src/frontend`

To initialize the submodule, run:
```bash
git submodule update --init --recursive
```

## Windows Desktop Application

A Windows desktop application is available, built with Tauri:
- Version: v1.0.1
- Features:
  - Cross-platform file downloads (browser and desktop)
  - Advanced download management with progress tracking
  - File browsing and organization
  - User authentication and profile management
  - Multi-user file access control
  - Settings customization

## Installation

### Prerequisites

- Python 3.12+
- Node.js 16+
- MongoDB
- Telegram API credentials

### Quick Setup

1. Clone the repository with submodules:
   ```bash
   git clone --recurse-submodules <repository-url>
   cd fileServer
   ```

2. If you've already cloned the repository without submodules, initialize them:
   ```bash
   git submodule update --init --recursive
   ```

3. Install Python dependencies:
   ```bash
   pip install -r requirements.txt
   ```

4. Install frontend dependencies:
   ```bash
   cd src/frontend
   npm install
   ```

5. Set up environment variables:
   Copy `.env.example` to `.env` and configure your settings:
   ```
   API_ID=your_telegram_api_id
   API_HASH=your_telegram_api_hash
   TOKEN0=your_bot_token
   DATABASE_URL=your_mongodb_connection_string
   ```

6. Run the application:
   ```bash
   python __main__.py
   ```

### Production Deployment

#### Using Systemd (Linux)

Run the installation script to set up a systemd service:
```bash
chmod +x install.sh
./install.sh
```

This creates a service named `telegram-file-server` that can be managed with:
```bash
tgserver start     # Start the service
tgserver stop      # Stop the service
tgserver restart   # Restart the service
tgserver status    # Check service status
tgserver logs      # View live logs
```

#### Using Docker

Build and run with Docker:
```bash
docker build -t telegram-file-server .
docker run -p 8000:8000 telegram-file-server
```

#### Heroku Deployment

The application supports Heroku deployment through the provided `app.json` and `heroku.yml`.

## Multi-User Model

The Telegram File Server now supports multiple users with per-file ownership and access control:

- Each file and folder is associated with an owner (user ID)
- Users can only access files they own
- Files uploaded via Telegram are associated with the Telegram account owner
- All file operations (view, move, copy, delete, rename) are restricted to owners
- Admin users can access all files

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `API_ID` | Telegram API ID | Yes |
| `API_HASH` | Telegram API Hash | Yes |
| `TOKEN0` | Primary bot token | Yes |
| `DATABASE_URL` | MongoDB connection string | Yes |
| `OWNER` | Owner user ID | No |
| `PORT` | Web server port (default: 8000) | No |
| `GOOGLE_CLIENT_ID` | For Google OAuth | No |
| `GOOGLE_CLIENT_SECRET` | For Google OAuth | No |

Additional bot tokens can be added as `TOKEN1`, `TOKEN2`, etc.

## Usage

### Web Interface

After starting the server, access the web interface at `http://localhost:8000` (or your configured port).

Features include:
- File browsing with folder navigation
- Virtual folders for media types (Images, Videos, Documents, Audio)
- Search functionality
- File operations (create folder, copy, move, etc.)

### Telegram Commands

The bot supports various commands for file management:
- `/start` - Welcome message
- File upload/download through Telegram

### API Endpoints

- `GET /` - Application information
- `POST /api/auth/login` - User authentication
- `GET /api/files` - List files in a path (filtered by owner)
- `POST /api/folders/create` - Create a new folder (assigned to current user)
- `GET /api/bots/info` - Get bot information

All file operations are restricted to the owner of the files. Full API documentation is available at `/docs` when the server is running.

## Development

### Backend Development

The backend is written in Python using FastAPI. Key directories:
- `src/Backend/` - Web server implementation
- `src/Database/` - MongoDB models and connections
- `src/Telegram/` - Bot implementations
- `src/Config/` - Configuration files

### Frontend Development

The frontend uses React with Vite and is located in the `src/frontend` directory:
```bash
cd src/frontend
npm run dev  # Start development server
npm run build  # Build for production
```

Key directories:
- `src/frontend/src/components/` - React components
- `src/frontend/src/hooks/` - Custom React hooks
- `src/frontend/src/pages/` - Page components
- `src/frontend/src/lib/` - Utility functions

The frontend is a submodule repository hosted at https://github.com/pamod-madubashana/FileServerApp

### Building the Windows Desktop App

To build the Windows desktop application using Tauri:

1. Navigate to the frontend directory:
   ```bash
   cd src/frontend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Install Tauri CLI globally:
   ```bash
   npm install -g @tauri-apps/cli
   ```

4. Build the desktop app:
   ```bash
   npm run tauri build
   ```

The built application will be available in `src/frontend/src-tauri/target/release/bundle/` with installers for Windows.

## Security

- Session-based authentication with secure middleware
- CORS protection
- Protected API endpoints
- Secure handling of Telegram credentials

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For support, please open an issue on the GitHub repository or contact the maintainers.