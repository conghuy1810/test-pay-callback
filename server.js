require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 5730;

// MySQL connection pool
const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'payments',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Logs for callback requests (in-memory for non-webhook callbacks)
const callbacks = [];

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// SePay webhook endpoint
app.post('/webhook/sepay', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const body = req.body.toString('utf8');
    
    if (!body) {
      return res.status(400).json({ success: false, message: 'Empty body' });
    }

    // 1. HMAC-SHA256 signature verification
    const signature = req.headers['x-sepay-signature'] ?? '';
    const timestamp = Number(req.headers['x-sepay-timestamp'] ?? 0);
    const secret = process.env.SEPAY_WEBHOOK_SECRET;

    if (!secret) {
      console.error('Missing SEPAY_WEBHOOK_SECRET in environment');
      return res.status(500).json({ success: false, message: 'Server configuration error' });
    }

    // Anti-replay: timestamp must be within 5 minutes
    if (Math.abs(Date.now() / 1000 - timestamp) > 300) {
      return res.status(401).json({ success: false, message: 'Request expired' });
    }

    // Verify HMAC-SHA256
    const expected = 'sha256=' + crypto.createHmac('sha256', secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');

    const sig = Buffer.from(signature);
    const exp = Buffer.from(expected);

    if (sig.length !== exp.length || !crypto.timingSafeEqual(sig, exp)) {
      console.warn('Invalid signature:', { signature, expected });
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }

    // 2. Parse JSON payload
    let data;
    try {
      data = JSON.parse(body);
    } catch (err) {
      return res.status(400).json({ success: false, message: 'Invalid JSON' });
    }

    if (!data?.id) {
      return res.status(400).json({ success: false, message: 'Invalid payload - missing id' });
    }

    // 3. Idempotency: INSERT IGNORE prevents duplicate processing
    const [result] = await db.execute(
      `INSERT IGNORE INTO transactions
       (sepay_id, gateway, transaction_date, account_number, sub_account,
        code, amount_in, amount_out, accumulated, content, reference_code, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.id,
        data.gateway || '',
        data.transactionDate || new Date().toISOString(),
        data.accountNumber || '',
        data.subAccount || '',
        data.code || '',
        data.transferType === 'in' ? data.transferAmount : 0,
        data.transferType === 'out' ? data.transferAmount : 0,
        data.accumulated || 0,
        data.content || '',
        data.referenceCode || '',
        body
      ]
    );

    if (result.affectedRows === 0) {
      // Already processed - return OK to prevent SePay retry
      console.log('Duplicate transaction ignored:', data.id);
      return res.json({ success: true });
    }

    console.log('✓ Transaction processed:', data.id, data.transferAmount, data.code);

    // 4. Business logic: execute only on first INSERT
    if (data.transferType === 'in' && data.code) {
      // Update order status to 'paid'
      await db.execute(
        `UPDATE orders SET status = 'paid', paid_at = NOW()
         WHERE code = ? AND status = 'pending' AND amount <= ?`,
        [data.code, data.transferAmount]
      );

      // TODO: enqueue job for email, inventory update, etc.
    }

    res.json({ success: true });
  } catch (err) {
    console.error('SePay webhook error:', err);
    res.status(500).json({ success: false, message: 'Internal error' });
  }
});

// Legacy callback endpoint (for backwards compatibility)
app.post('/callback', (req, res) => {
  const callbackData = {
    receivedAt: new Date().toISOString(),
    body: req.body,
    headers: req.headers,
    ip: req.ip
  };

  callbacks.push(callbackData);
  console.log('✓ Callback received:', callbackData);

  res.status(200).json({
    success: true,
    message: 'Callback received successfully',
    id: callbacks.length
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════╗
║   Payment Callback Server Started             ║
╠════════════════════════════════════════════════╣
║   Server running on: http://localhost:${PORT}     ║
║   Health check: GET /health                   ║
║   SePay webhook: POST /webhook/sepay          ║
║   Legacy callback: POST /callback             ║
║   View callbacks: GET /callbacks              ║
║   View callback: GET /callbacks/:id           ║
║   Clear callbacks: DELETE /callbacks          ║
╚════════════════════════════════════════════════╝
  `);
});
