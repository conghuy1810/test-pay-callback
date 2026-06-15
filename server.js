require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const rateLimit = require('express-rate-limit');
const joi = require('joi');
const helmet = require('helmet');

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

// Optional billing webdb pool (for updating tkbb.cash_refer)
const billingDb = mysql.createPool({
  host: process.env.BILLING_DB_HOST || process.env.DB_HOST || 'localhost',
  user: process.env.BILLING_DB_USER || process.env.DB_USER || 'root',
  password: process.env.BILLING_DB_PASS || process.env.DB_PASS || 'root123',
  database: process.env.BILLING_DB_NAME || 'billing',
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0
});


// ============================================================================
// RATE LIMITERS
// ============================================================================
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false,
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 50, // Higher limit for webhook (SePay might retry)
  skip: (req) => {
    // Skip rate limit if signature is valid (will be verified later)
    return !req.headers['x-sepay-signature'];
  },
  message: 'Webhook rate limit exceeded',
});

const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // Very strict for order creation
  message: 'Too many order creation requests, please try again later.',
});

// Middleware
app.use(bodyParser.json({ limit: '1mb' })); // Limit payload size
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));

// Security: Helmet middleware (sets various HTTP headers)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
    }
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true } // HTTPS only
}));

// Security: Prevent parameter pollution
app.use((req, res, next) => {
  for (const key in req.query) {
    if (Array.isArray(req.query[key])) {
      req.query[key] = req.query[key][0]; // Take first value only
    }
  }
  next();
});

// Apply general rate limiter
app.use(generalLimiter);

// CORS support - restrict to common origins
app.use((req, res, next) => {
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || ['localhost', '127.0.0.1'];
  const origin = req.get('origin');
  
  if (!origin || allowedOrigins.some(allowed => origin.includes(allowed))) {
    res.header('Access-Control-Allow-Origin', origin || 'http://localhost:3000');
  }
  
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

// SePay Configuration (set in .env)
const SEPAY_ACCOUNT = process.env.SEPAY_ACCOUNT || '0010000000355';
const SEPAY_BANK = process.env.SEPAY_BANK || 'Vietcombank';

// Logs for callback requests (in-memory for non-webhook callbacks)
const callbacks = [];

// ============================================================================
// SECURITY UTILITIES
// ============================================================================
// Safe logger - doesn't log sensitive data
const safeLog = {
  info: (msg, data = {}) => {
    const safe = {};
    for (const [k, v] of Object.entries(data)) {
      if (['signature', 'password', 'secret', 'token', 'authorization', 'body'].includes(k.toLowerCase())) {
        safe[k] = '[REDACTED]';
      } else {
        safe[k] = v;
      }
    }
    console.log(`[INFO] ${msg}`, Object.keys(safe).length > 0 ? safe : '');
  },
  error: (msg, err) => {
    console.error(`[ERROR] ${msg}`, err?.message || err);
  },
  warn: (msg, data = {}) => {
    console.warn(`[WARN] ${msg}`, data);
  }
};

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================
const orderSchema = joi.object({
  des: joi.string().max(100).allow(null, ''),
  amount: joi.number().integer().positive().max(999999999).required()
});

const codeSchema = joi.object({
  code: joi.string().max(100).required()
});

// Middleware to validate request
const validateRequest = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, {
    abortEarly: true,
    stripUnknown: true // Remove unknown fields
  });

  if (error) {
    return res.status(400).json({
      success: false,
      message: 'Invalid input',
      details: error.details.map(d => d.message)
    });
  }

  req.body = value; // Replace with validated data
  next();
};

// ============================================================================
// ORDERS API - Create orders with QR codes
// ============================================================================
const ordersRouter = express.Router();

ordersRouter.post('/', strictLimiter, validateRequest(orderSchema), async (req, res) => {
  try {
    const { des: code, amount } = req.body;

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
    safeLog.error('Order creation error', err);
    res.status(500).json({ success: false, message: 'Failed to create order' });
  }
});

ordersRouter.get('/:code/status', validateRequest(joi.object({ code: joi.string().max(100).required() }).keys({ code: joi.any() }).pattern(joi.string(), joi.any())), async (req, res) => {
  try {
    const code = req.params.code;
    
    // Validate code parameter
    const { error, value } = joi.string().max(100).required().validate(code);
    if (error) {
      return res.status(400).json({ success: false, message: 'Invalid code parameter' });
    }

    const [rows] = await db.execute(
      'SELECT status FROM orders WHERE code = ?',
      [value]
    );
    res.json({ status: rows[0]?.status ?? 'not_found' });
  } catch (err) {
    safeLog.error('Status check error', err);
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
app.post('/webhook/sepay', webhookLimiter, express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const body = req.body.toString('utf8');
    
    if (!body) {
      return res.status(400).json({ success: false, message: 'Empty body' });
    }

    // Validate body is valid JSON before processing
    let data;
    try {
      data = JSON.parse(body);
    } catch (err) {
      return res.status(400).json({ success: false, message: 'Invalid JSON' });
    }

    // 1. HMAC-SHA256 signature verification
    const signature = req.headers['x-sepay-signature'] ?? '';
    const timestamp = Number(req.headers['x-sepay-timestamp'] ?? 0);
    const secret = process.env.SEPAY_WEBHOOK_SECRET;

    if (!secret) {
      safeLog.error('Missing SEPAY_WEBHOOK_SECRET in environment', null);
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
      safeLog.warn('Invalid signature detected');
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }

    if (!data?.id) {
      return res.status(400).json({ success: false, message: 'Invalid payload - missing id' });
    }

    // Validate critical fields
    if (typeof data.id !== 'string' || data.id.length > 255) {
      return res.status(400).json({ success: false, message: 'Invalid transaction ID' });
    }

    if (data.transferAmount && (typeof data.transferAmount !== 'number' || data.transferAmount <= 0)) {
      return res.status(400).json({ success: false, message: 'Invalid transfer amount' });
    }

    // 3. Idempotency: INSERT IGNORE prevents duplicate processing
    const [result] = await db.execute(
      `INSERT IGNORE INTO transactions
       (sepay_id, gateway, transaction_date, account_number, sub_account,
        code, amount_in, amount_out, accumulated, content, reference_code, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.id,
        (data.gateway || '').substring(0, 100),
        data.transactionDate || new Date().toISOString(),
        (data.accountNumber || '').substring(0, 100),
        (data.subAccount || '').substring(0, 100),
        (data.code || '').substring(0, 100),
        data.transferType === 'in' ? data.transferAmount : 0,
        data.transferType === 'out' ? data.transferAmount : 0,
        data.accumulated || 0,
        (data.content || '').substring(0, 500),
        (data.referenceCode || '').substring(0, 100),
        body
      ]
    );

    if (result.affectedRows === 0) {
      // Already processed - return OK to prevent SePay retry
      safeLog.info('Duplicate transaction ignored', { transaction_id: data.id });
      return res.json({ success: true });
    }

    safeLog.info('Transaction processed', { 
      transaction_id: data.id, 
      amount: data.transferAmount, 
      code: data.code 
    });

    // 4. Business logic: execute only on first INSERT
    if (data.transferType === 'in' && data.code) {
      // Update order status to 'paid'
      await db.execute(
        `UPDATE orders SET status = 'paid', paid_at = NOW()
         WHERE code = ? AND status = 'pending' AND amount <= ?`,
        [data.code, data.transferAmount]
      );

      // Update billing.tkbb.cash_refer when order code indicates a top-up (starts with NAPJ)
      try {
        if (typeof data.code === 'string' && data.code.startsWith('NAPJ')) {
          const cashRefer = (data.referenceCode || '').substring(0, 100);
          const accountNumber = (data.accountNumber || '').substring(0, 100);
          if (accountNumber) {
            await billingDb.execute(
              `UPDATE tkbb SET cash_refer = ? WHERE account_number = ?`,
              [cashRefer, accountNumber]
            );
            safeLog.info('Updated tkbb.cash_refer', { accountNumber, cashRefer });
          } else {
            safeLog.warn('No accountNumber to update tkbb.cash_refer', { transaction_id: data.id });
          }
        }
      } catch (err) {
        safeLog.error('Billing DB update failed', err);
      }

      // TODO: enqueue job for email, inventory update, etc.
    }

    res.json({ success: true });
  } catch (err) {
    safeLog.error('SePay webhook error', err);
    res.status(500).json({ success: false, message: 'Internal error' });
  }
});

// Legacy callback endpoint (for backwards compatibility)
app.post('/callback', generalLimiter, (req, res) => {
  // Validate callback body size
  if (!req.body || Object.keys(req.body).length === 0) {
    return res.status(400).json({ success: false, message: 'Empty callback body' });
  }

  const callbackData = {
    receivedAt: new Date().toISOString(),
    body: req.body,
    headers: req.headers,
    ip: req.ip
  };

  callbacks.push(callbackData);
  safeLog.info('Legacy callback received', { ip: callbackData.ip, body_keys: Object.keys(callbackData.body) });

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
  safeLog.info('Server started', { 
    port: PORT, 
    env: process.env.NODE_ENV || 'development'
  });
  console.log(`
╔════════════════════════════════════════════════╗
║   Payment Callback Server Started             ║
╠════════════════════════════════════════════════╣
║   Server running on: http://localhost:${PORT}     ║
║   Environment: ${(process.env.NODE_ENV || 'development').padEnd(29)}║
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
