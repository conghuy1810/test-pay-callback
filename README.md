# Payment Callback Server

A simple Node.js server built with Express that receives and logs payment callbacks/webhooks.

## Installation

```bash
npm install
```

## Usage

### Start the server (production)
```bash
npm start
```

### Start the server (development with auto-reload)
```bash
npm run dev
```

The server will run on `http://localhost:3000`

## API Endpoints

### 1. Health Check
- **Endpoint:** `GET /health`
- **Description:** Check if the server is running
- **Response:** 
```json
{
  "status": "OK",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### 2. Receive Callback
- **Endpoint:** `POST /callback`
- **Description:** Receive payment callbacks/webhooks
- **Body:** Any JSON data
- **Response:** 
```json
{
  "success": true,
  "message": "Callback received successfully",
  "id": 1
}
```

### 3. View All Callbacks
- **Endpoint:** `GET /callbacks`
- **Description:** List all received callbacks
- **Response:**
```json
{
  "total": 2,
  "callbacks": [
    {
      "receivedAt": "2024-01-15T10:30:00.000Z",
      "body": {...},
      "headers": {...},
      "ip": "127.0.0.1"
    }
  ]
}
```

### 4. View Specific Callback
- **Endpoint:** `GET /callbacks/:id`
- **Description:** Get details of a specific callback
- **Response:** Callback object

### 5. Clear All Callbacks
- **Endpoint:** `DELETE /callbacks`
- **Description:** Remove all stored callbacks
- **Response:**
```json
{
  "message": "Cleared 2 callbacks"
}
```

## Example: Send a Callback

```bash
curl -X POST http://localhost:3000/callback \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "12345",
    "status": "completed",
    "amount": 100.00,
    "currency": "USD"
  }'
```

## Environment Variables

- `PORT` - Server port (default: 3000)

```bash
PORT=8080 npm start
```

## Project Structure

```
pay-callback/
├── server.js          # Main server file
├── package.json       # Project dependencies
├── .gitignore        # Git ignore rules
└── README.md         # This file
```

## Notes

- Callbacks are stored in memory (will be lost on restart)
- For production, consider using a database to persist callbacks
- All callbacks include timestamp, headers, and IP address information
