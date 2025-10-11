# Streaming API

A Node.js API for streaming videos from magnet torrent links using WebTorrent.

## Features

- Stream videos directly from magnet links
- Support for multiple video formats (MP4, MKV, AVI, WebM)
- Range request support for efficient streaming
- Automatic torrent cleanup and resource management
- Docker support
- CORS enabled for web applications

## Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

## Usage

### Development
```bash
npm run dev
```

### Production
```bash
npm start
```

The server will start on `http://localhost:3000` (or the port specified in the PORT environment variable).

## API Endpoints

### Stream Video from Torrent
```
GET /api/torrent/:magnet
```
Streams the largest video file from a magnet link.

**Example:**
```
GET /api/torrent/magnet:?xt=urn:btih:...
```

### Stream Local Video File
```
GET /api/stream/:filename
```
Streams a video file from the local videos directory.

**Example:**
```
GET /api/stream/movie.mp4
```

### Health Check
```
GET /api/ping
```
Returns server status and active torrent information.

## Docker

Build and run with Docker:

```bash
docker build -t streaming-api .
docker run -p 3000:3000 streaming-api
```

## Configuration

The API automatically manages resources with these settings:
- Maximum 20 active torrents
- Torrents timeout after 10 minutes of inactivity
- Automatic cleanup every 2 minutes
- Files are cleaned up 30 seconds after streaming ends

## Requirements

- Node.js 18+
- npm

## Dependencies

- Express.js - Web framework
- WebTorrent - Torrent client
- CORS - Cross-origin resource sharing

## License

MIT
