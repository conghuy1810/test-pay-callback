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
  password: process.env.DB_PASS || 'root123',
  database: process.env.DB_NAME || 'payments',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Initialize database tables
async function initializeDatabase() {
  try {
    const connection = await db.getConnection();
    
    // Create tables
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS transactions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        sepay_id VARCHAR(255) UNIQUE NOT NULL COMMENT 'SePay transaction ID',
        gateway VARCHAR(100) COMMENT 'Payment gateway',
        transaction_date DATETIME,
        account_number VARCHAR(100),
        sub_account VARCHAR(100),
        code VARCHAR(100) COMMENT 'Order/reference code',
        amount_in DECIMAL(15, 2) DEFAULT 0 COMMENT 'Incoming amount',
        amount_out DECIMAL(15, 2) DEFAULT 0 COMMENT 'Outgoing amount',
        accumulated DECIMAL(15, 2),
        content VARCHAR(500) COMMENT 'Transaction description',
        reference_code VARCHAR(100),
        body LONGTEXT COMMENT 'Raw webhook body',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_sepay_id (sepay_id),
        INDEX idx_code (code),
        INDEX idx_created_at (created_at)
      )
    `);
    
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS webhook_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        transaction_id BIGINT NOT NULL UNIQUE COMMENT 'ID giao dịch SePay',
        body JSON NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS orders (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(100) UNIQUE NOT NULL,
        amount DECIMAL(15, 2) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        paid_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_code (code),
        INDEX idx_status (status)
      )
    `);
    
    connection.release();
    console.log('✓ Database tables initialized successfully');
  } catch (err) {
    console.error('Database initialization error:', err);
    process.exit(1);
  }
}

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// SePay Configuration (set in .env)
const SEPAY_ACCOUNT = process.env.SEPAY_ACCOUNT || '0010000000355';
const SEPAY_BANK = process.env.SEPAY_BANK || 'Vietcombank';

// Logs for callback requests (in-memory for non-webhook callbacks)
const callbacks = [];

// ============================================================================
// ORDERS API - Create orders with QR codes
// ============================================================================
const ordersRouter = express.Router();

ordersRouter.post('/', async (req, res) => {
  try {
    const idUser = req.body.idUser || null;
    const amount = Number(req.body.amount) || 100000;

    const code = 'DH' + idUser;
    await db.execute(
      'INSERT INTO orders (code, amount, status) VALUES (?, ?, ?)',
      [code, amount, 'pending']
    );

    const qr = new URLSearchParams({
      acc: SEPAY_ACCOUNT,
      bank: SEPAY_BANK,
      amount: String(amount),
      des: code,
    });

    res.json({
      code,
      amount,
      bank: SEPAY_BANK,
      accountNumber: SEPAY_ACCOUNT,
      qrUrl: `https://qr.sepay.vn/img?${qr}`,
    });
  } catch (err) {
    console.error('Order creation error:', err);
    res.status(500).json({ success: false, message: 'Failed to create order' });
  }
});

ordersRouter.get('/:code/status', async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT status FROM orders WHERE code = ?',
      [req.params.code]
    );
    res.json({ status: rows[0]?.status ?? 'not_found' });
  } catch (err) {
    console.error('Status check error:', err);
    res.status(500).json({ success: false, message: 'Failed to check status' });
  }
});

app.use('/api/orders', ordersRouter);

// ============================================================================
// HEALTH CHECK
// ============================================================================
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
app.listen(PORT, async () => {
  await initializeDatabase();
  console.log(`
╔════════════════════════════════════════════════╗
║   Payment Callback Server Started             ║
╠════════════════════════════════════════════════╣
║   Server running on: http://localhost:${PORT}     ║
║                                                ║
║   ENDPOINTS:                                   ║
║   GET  /health                  - Health check ║
║   POST /api/orders              - Create order ║
║   GET  /api/orders/:code/status - Check status ║
║   POST /webhook/sepay           - SePay webhook║
║   POST /callback                - Legacy call  ║
╚════════════════════════════════════════════════╝
  `);
});
