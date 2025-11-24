# Telegram File Server

Telegram File Server is a powerful, self-hosted media server application that integrates with Telegram bots to provide file storage, organization, and streaming capabilities through a web interface.

## Features

- **Telegram Integration**: Uses Pyrogram to connect with Telegram bots for file management
- **Web Interface**: Modern React frontend with TypeScript and TailwindCSS
- **File Management**: Organize files in folders, search, and filter by type
- **Media Streaming**: Built-in support for streaming videos, images, documents, and audio
- **Authentication**: Secure login with local accounts or Google OAuth
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

## Installation

### Prerequisites

- Python 3.12+
- Node.js 16+
- MongoDB
- Telegram API credentials

### Quick Setup

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd fileServer
   ```

2. Install Python dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Install frontend dependencies:
   ```bash
   cd src/Frontend
   npm install
   ```

4. Set up environment variables:
   Copy `.env.example` to `.env` and configure your settings:
   ```
   API_ID=your_telegram_api_id
   API_HASH=your_telegram_api_hash
   TOKEN0=your_bot_token
   DATABASE_URL=your_mongodb_connection_string
   ```

5. Run the application:
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
prime start     # Start the service
prime stop      # Stop the service
prime restart   # Restart the service
prime status    # Check service status
prime logs      # View live logs
```

#### Using Docker

Build and run with Docker:
```bash
docker build -t telegram-file-server .
docker run -p 8000:8000 telegram-file-server
```

#### Heroku Deployment

The application supports Heroku deployment through the provided `app.json` and `heroku.yml`.

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
- `GET /api/files` - List files in a path
- `POST /api/folders/create` - Create a new folder
- `GET /api/bots/info` - Get bot information

Full API documentation is available at `/docs` when the server is running.

## Development

### Backend Development

The backend is written in Python using FastAPI. Key directories:
- `src/Backend/` - Web server implementation
- `src/Database/` - MongoDB models and connections
- `src/Telegram/` - Bot implementations
- `src/Config/` - Configuration files

### Frontend Development

The frontend uses React with Vite:
```bash
cd src/Frontend
npm run dev  # Start development server
npm run build  # Build for production
```

Key directories:
- `src/Frontend/src/components/` - React components
- `src/Frontend/src/hooks/` - Custom React hooks
- `src/Frontend/src/pages/` - Page components
- `src/Frontend/src/lib/` - Utility functions

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