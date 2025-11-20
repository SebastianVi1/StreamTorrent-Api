# Streaming API

A Node.js API for streaming videos from magnet torrent links using WebTorrent.

## Features

- Stream videos directly from magnet links
- Support for multiple video formats (MP4, MKV, AVI, WebM)
- Byte-range only streaming with backpressure (prevents loading the whole file in memory)
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

> ℹ️ The client **must** send a `Range` header (e.g. `Range: bytes=0-4194303`). The API responds with partial content chunks (default 4 MB) to keep memory usage low.

### Stream Local Video File
```
GET /api/stream/:filename
```
Streams a video file from the local videos directory.

**Example:**
```
GET /api/stream/movie.mp4
```

> ℹ️ This endpoint also enforces byte-range streaming. Requests without a valid `Range` header are rejected with HTTP 416 so make sure the player asks for chunks explicitly.

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
- Streams are served in chunks of 4 MB (configurable)
- Individual files above 5 GB are rejected to protect low-resource hosts

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `STREAM_CHUNK_SIZE_BYTES` | `4194304` (4 MB) | Maximum chunk size returned per request. Reduce if clients have limited bandwidth or RAM. |
| `STREAM_MAX_FILE_SIZE_BYTES` | `5368709120` (5 GB) | Rejects files above this size before allocating resources. |
| `STREAM_ENABLE_PROD_LOGS` | `false` | Structured JSON logs are emitted whenever `NODE_ENV=production` or this flag is set to `true`. |

## Requirements

- Node.js 18+
- npm

## Dependencies

- Express.js - Web framework
- WebTorrent - Torrent client
- CORS - Cross-origin resource sharing

## License

MIT
