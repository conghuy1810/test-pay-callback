# Payment Callback Server

A Node.js server built with Express that receives and logs payment callbacks/webhooks, with full support for **SePay webhook** integration including HMAC-SHA256 signature verification and idempotent transaction processing.

## Installation

```bash
npm install
```

## Database Setup

```bash
# Create database and tables
mysql -u root < database.sql

# Or manually in MySQL:
mysql> source database.sql;
```

## Configuration

Copy `.env.example` to `.env` and update:

```bash
cp .env.example .env
```

Edit `.env`:
```env
PORT=5730
NODE_ENV=development
DB_HOST=localhost
DB_USER=root
DB_PASS=
DB_NAME=payments
SEPAY_WEBHOOK_SECRET=your_secret_from_sepay_dashboard
```

Get your `SEPAY_WEBHOOK_SECRET` from SePay dashboard → Webhooks settings.

## Usage

### Start the server (production)
```bash
npm start
```

### Start the server (development with auto-reload)
```bash
npm run dev
```

The server will run on `http://localhost:5730`

## API Endpoints

### 1. Health Check
- **Endpoint:** `GET /health`
- **Description:** Check if the server is running

### 2. SePay Webhook ⭐ (Main Endpoint)
- **Endpoint:** `POST /webhook/sepay`
- **Description:** Receive and verify SePay payment transactions
- **Headers (required):**
  - `x-sepay-signature`: HMAC-SHA256 signature
  - `x-sepay-timestamp`: Request timestamp (Unix)
  - `Content-Type: application/octet-stream`
- **Features:**
  - ✅ HMAC-SHA256 signature verification
  - ✅ Replay attack protection (5-minute window)
  - ✅ Idempotent processing (INSERT IGNORE)
  - ✅ Duplicate transaction detection
  - ✅ Auto-update order status on payment

**Example signature generation (for testing):**
```javascript
const crypto = require('crypto');
const timestamp = Math.floor(Date.now() / 1000);
const body = JSON.stringify({ id: '12345', transferAmount: 100 });
const secret = 'your_secret';
const signature = 'sha256=' + crypto
  .createHmac('sha256', secret)
  .update(`${timestamp}.${body}`)
  .digest('hex');
```

### 3. Legacy Callback Endpoint (backwards compatible)
- **Endpoint:** `POST /callback`
- **Description:** Simple callback receiver (no signature verification)

### 4. View All Callbacks
- **Endpoint:** `GET /callbacks`
- **Description:** List callbacks from legacy `/callback` endpoint

### 5. View Specific Callback
- **Endpoint:** `GET /callbacks/:id`

### 6. Clear All Callbacks
- **Endpoint:** `DELETE /callbacks`

## Database Schema

### transactions table
Stores all verified SePay transactions with idempotency:
- `sepay_id` - Unique transaction ID from SePay
- `code` - Order/reference code
- `amount_in` / `amount_out` - Transaction amounts
- `body` - Raw webhook payload (for audit)

### orders table
Example business logic table:
- Auto-updated to "paid" status when payment received
- Prevents double-processing

## Key Features

✅ **HMAC-SHA256 Verification** - Ensures webhook authenticity  
✅ **Replay Attack Protection** - 5-minute timestamp validation  
✅ **Idempotent Processing** - INSERT IGNORE prevents duplicates  
✅ **Auto Business Logic** - Updates orders on payment confirmation  
✅ **Error Handling** - Comprehensive logging and error responses  
✅ **Backwards Compatible** - Legacy `/callback` endpoint still works  

## Example: Test SePay Webhook

```bash
# Generate timestamp and signature
TIMESTAMP=$(date +%s)
BODY='{"id":"test123","transferType":"in","transferAmount":100,"code":"ORDER001"}'
SECRET="your_secret"
SIGNATURE="sha256=$(echo -n "$TIMESTAMP.$BODY" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)"

# Send webhook
curl -X POST http://localhost:5730/webhook/sepay \
  -H "x-sepay-signature: $SIGNATURE" \
  -H "x-sepay-timestamp: $TIMESTAMP" \
  -H "Content-Type: application/octet-stream" \
  -d "$BODY"
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 5730 | Server port |
| `DB_HOST` | localhost | MySQL host |
| `DB_USER` | root | MySQL user |
| `DB_PASS` | (empty) | MySQL password |
| `DB_NAME` | payments | Database name |
| `SEPAY_WEBHOOK_SECRET` | (required) | SePay webhook secret |

## Project Structure

```
pay-callback/
├── server.js          # Main Express server
├── package.json       # Dependencies
├── database.sql       # MySQL schema
├── .env.example       # Configuration template
├── .gitignore         # Git rules
└── README.md          # This file
```

## Production Notes

- **Database Persistence** - Transactions stored in MySQL (not memory)
- **Duplicate Prevention** - UNIQUE constraint on `sepay_id`
- **Audit Trail** - Raw webhook body stored for compliance
- **Error Handling** - Proper HTTP status codes and logging
- **Connection Pool** - MySQL connection pooling for performance

## Error Responses

| Status | Message | Reason |
|--------|---------|--------|
| 400 | Empty body | No request body |
| 400 | Invalid payload | Missing `id` field |
| 401 | Request expired | Timestamp > 5 minutes |
| 401 | Invalid signature | Signature verification failed |
| 500 | Internal error | Database or server error |

## References

- [SePay Webhook Documentation](https://developer.sepay.vn/vi/sepay-webhooks/lap-trinh-webhooks/lap-trinh-webhook-nodejs)
- [HMAC-SHA256 in Node.js](https://nodejs.org/api/crypto.html#crypto_class_hmac)

