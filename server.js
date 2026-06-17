require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const parseForwarded = require("forwarded-parse");
const joi = require("joi");
const helmet = require("helmet");

const app = express();
const PORT = process.env.PORT || 5730;
const DEFAULT_TOPUP_STATUS = Number(process.env.DEFAULT_TOPUP_STATUS ?? 1);

const db = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || process.env.DB_PASS || "",
  database: process.env.DB_NAME || "payments",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

app.set("trust proxy", 1);


// ============================================================================
// RATE LIMITERS
// ============================================================================
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: "Too many requests from this IP, please try again later.",
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false,
});

// const webhookLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 phút
//   max: 100, // Giới hạn 100 request
//   standardHeaders: true,
//   legacyHeaders: false,

//   // 🔥 BƯỚC 1: Tắt tính năng tự động check IP của Express để không bị văng lỗi 'unknown'
//   validate: { ip: false },

//   // 🔥 BƯỚC 2: Tự định nghĩa cách lấy IP trực tiếp từ Header của Nginx
//   keyGenerator: (req, res) => {
//     let ip = req.ip;
//     try {
//       const forwards = parseForwarded(req.headers.forwarded);
//       ip = forwards[forwards.length - NUMBER_OF_PROXIES_TO_TRUST].for;
//     } catch (ex) {
//       console.error(
//         `Error parsing Forwarded header ${req.headers.forwarded} from ${req.ip}:`,
//         ex,
//       );
//     }
//     // Gọi hàm ipKeyGenerator đã lấy ra ở trên
//     return ipKeyGenerator(ip);
//   },
// });

const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 phút
  max: 100, // Giới hạn 100 requests mỗi IP
  standardHeaders: true,
  legacyHeaders: false,

  // 🔥 THÊM ĐOẠN NÀY ĐỂ SỬA TRIỆT ĐỂ LỖI UNKNOWN:
  keyGenerator: (req) => {
    // 1. Lấy IP từ header X-Forwarded-For hoặc X-Real-IP do Nginx gửi sang
    let ip = req.headers["x-forwarded-for"] || req.headers["x-real-ip"];

    // 2. Nếu Nginx gửi dạng chuỗi danh sách (IP1, IP2), lấy cái đầu tiên
    if (ip && ip.includes(",")) {
      ip = ip.split(",")[0];
    }

    // 3. Nếu vẫn không lấy được (hoặc bằng 'unknown'), fallback về IP kết nối trực tiếp hoặc chuỗi mặc định
    if (!ip || ip === "unknown") {
      ip = req.socket.remoteAddress || "local-fallback-ip";
    }

    return ip.trim();
  },
});
// Middleware
app.use(bodyParser.json({ limit: "1mb" })); // Limit payload size
app.use(bodyParser.urlencoded({ extended: true, limit: "1mb" }));

// Security: Helmet middleware (sets various HTTP headers)
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
      },
    },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }, // HTTPS only
  }),
);

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
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",") || [
    "localhost",
    "127.0.0.1",
  ];
  const origin = req.get("origin");

  if (!origin || allowedOrigins.some((allowed) => origin.includes(allowed))) {
    res.header(
      "Access-Control-Allow-Origin",
      origin || "http://localhost:3000",
    );
  }

  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization",
  );
  res.header("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// SePay Configuration (set in .env)
const SEPAY_ACCOUNT = "26254221";
const SEPAY_BANK = "ACB";

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
      if (
        [
          "signature",
          "password",
          "secret",
          "token",
          "authorization",
          "body",
        ].includes(k.toLowerCase())
      ) {
        safe[k] = "[REDACTED]";
      } else {
        safe[k] = v;
      }
    }
    console.log(`[INFO] ${msg}`, Object.keys(safe).length > 0 ? safe : "");
  },
  error: (msg, err) => {
    console.error(`[ERROR] ${msg}`, err?.message || err);
  },
  warn: (msg, data = {}) => {
    console.warn(`[WARN] ${msg}`, data);
  },
};

async function testDbConnection() {
  const conn = await db.getConnection();
  try {
    await conn.ping();
    safeLog.info("Database connected", {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 3306,
      database: process.env.DB_NAME,
    });
  } finally {
    conn.release();
  }
}

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================
const orderSchema = joi.object({
  amount: joi.number().integer().positive().max(999999999).required(),
  accountId: joi.number().integer().positive().required(),
});

const codeSchema = joi.object({
  code: joi.string().max(100).required(),
});

// Middleware to validate request
const validateRequest = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, {
    abortEarly: true,
    stripUnknown: true, // Remove unknown fields
  });

  if (error) {
    return res.status(400).json({
      success: false,
      message: "Invalid input",
      details: error.details.map((d) => d.message),
    });
  }

  req.body = value; // Replace with validated data
  next();
};

// ============================================================================
// ORDERS API - Create orders with QR codes
// ============================================================================

app.post(
  "/v1/orders",
  strictLimiter,
  validateRequest(orderSchema),
  async (req, res) => {
    try {
      const { amount, accountId } = req.body;

      const orderNo =
        `ORD${Date.now()}${crypto.randomBytes(4).toString("hex")}`.slice(0, 32);

      const [result] = await db.execute(
        `INSERT INTO \`order\` \
          (order_no, account_id, amount, status, channel, server_id, trade_no, note) \
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          orderNo,
          accountId,
          amount,
          0,
          "qrCode",
          1,
          null,
          null,
        ],
      );
      const encodedId = "TKCD" + result.insertId + " chuyen khoan";
      const qr = new URLSearchParams({
        acc: SEPAY_ACCOUNT,
        bank: SEPAY_BANK,
        amount: String(amount),
        des: encodedId,
      });

      res.json({
        success: true,
        orderId: result.insertId,
        amount,
        bank: SEPAY_BANK,
        accountNumber: SEPAY_ACCOUNT,
        qrUrl: `https://qr.sepay.vn/img?${qr}`,
      });
    } catch (err) {
      safeLog.error("Order creation error", err);
      res
        .status(500)
        .json({ success: false, message: "Failed to create order" });
    }
  },
);

// Order status check
app.get("/v1/orders/:orderId/status", async (req, res) => {
  try {
    const orderId = Number(req.params.orderId);
    if (!orderId || orderId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid orderId",
      });
    }

    const [rows] = await db.execute(
      `SELECT id, order_no, account_id, amount, status, pay_time FROM \`order\` WHERE id = ? LIMIT 1`,
      [orderId],
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const order = rows[0];
    res.json({
      success: true,
      orderId: order.id,
      orderNo: order.order_no,
      accountId: order.account_id,
      amount: order.amount,
      status: order.status === 1 ? "completed" : "pending",
      paid: order.status === 1,
      pay_time: order.pay_time,
    });
  } catch (err) {
    safeLog.error("Order status lookup error", err);
    res.status(500).json({ success: false, message: "Failed to fetch order status" });
  }
});

// ============================================================================
// HEALTH CHECK
// ============================================================================
// Health check endpoint
app.get("/health", async (req, res) => {
  let dbOk = false;
  try {
    const conn = await db.getConnection();
    try {
      await conn.ping();
      dbOk = true;
    } finally {
      conn.release();
    }
  } catch (err) {
    safeLog.error("Health check DB ping failed", err);
  }

  res.json({
    ok: true,
    db: dbOk,
    timestamp: new Date().toISOString(),
  });
});

// SePay webhook endpoint
app.post(
  "/webhook/sepay",
  // webhookLimiter,
  express.raw({ type: "*/*" }),
  async (req, res) => {
    try {
      const body = req.body;

      if (!body) {
        return res.status(400).json({ success: false, message: "Empty body" });
      }
      // Validate body is valid JSON before processing
      const data = body;

      // 1. HMAC-SHA256 signature verification
      const signature = req.headers["x-sepay-signature"] ?? "";
      const timestamp = Number(req.headers["x-sepay-timestamp"] ?? 0);
      const secret = process.env.SEPAY_WEBHOOK_SECRET;

      if (!secret) {
        return res
          .status(500)
          .json({ success: false, message: "Server configuration error" });
      }

      // Anti-replay: timestamp must be within 5 minutes
      if (Math.abs(Date.now() / 1000 - timestamp) > 300) {
        return res
          .status(401)
          .json({ success: false, message: "Request expired" });
      }
      const rawBody = JSON.stringify(req.body);
      // Verify HMAC-SHA256
      const expected =
        "sha256=" +
        crypto
          .createHmac("sha256", secret)
          .update(`${timestamp}.${rawBody}`)
          .digest("hex");

      const sig = Buffer.from(signature);
      const exp = Buffer.from(expected);
      if (sig.length !== exp.length || !crypto.timingSafeEqual(sig, exp)) {
        return res
          .status(401)
          .json({ success: false, message: "Invalid signature" });
      }
      if (!data?.id) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid payload - missing id" });
      }

      // Validate critical fields
      if (
        data.transferAmount &&
        (typeof data.transferAmount !== "number" || data.transferAmount <= 0)
      ) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid transfer amount" });
      }

      // 4. Business logic: execute only on first INSERT
      if (data.transferType === "in") {
        // Update order status to 'paid'
        // Use orderId from the webhook description to load the order and call topup with its saved account
        try {
          const cashTrans = data.transferAmount;
          const description = data.content;
          const match = description.match(/TKCD(\d+)/);
          if (description && cashTrans && match) {
            const orderId = parseInt(match[1], 10);
            const [orders] = await db.execute(
              `SELECT id, account_id FROM \`order\` WHERE id = ? LIMIT 1`,
              [orderId],
            );

            if (!orders || orders.length === 0) {
              return res
                .status(404)
                .json({ success: false, message: "Order not found" });
            }

            const order = orders[0];
            const topupRq = await fetch(
              `http://localhost:8379/api/accounts/${order.account_id}/topups`,
              {
                headers: {
                  accept: "*/*",
                  "accept-language": "vi,en-US;q=0.9,en;q=0.8",
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  account_id: order.account_id,
                  fee: Number(cashTrans),
                  server_id: "1",
                  channel: "qrCode",
                  trade_no: "",
                }),
                method: "POST",
              },
            );

            if (topupRq.ok) {
              await db.execute(
                `UPDATE \`order\` SET status = ?, pay_time = NOW() WHERE id = ?`,
                [1, orderId],
              );
            } else {
              safeLog.error("Topup service returned non-ok status", {
                status: topupRq.status,
                orderId,
              });
            }
          }
        } catch (err) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid payload - missing id" });
        }

        // TODO: enqueue job for email, inventory update, etc.
      }

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, message: "Internal error" });
    }
  },
);

// Legacy callback endpoint (for backwards compatibility)
app.post("/callback", generalLimiter, (req, res) => {
  // Validate callback body size
  if (!req.body || Object.keys(req.body).length === 0) {
    return res
      .status(400)
      .json({ success: false, message: "Empty callback body" });
  }

  const callbackData = {
    receivedAt: new Date().toISOString(),
    body: req.body,
    headers: req.headers,
    ip: req.ip,
  };

  callbacks.push(callbackData);
  safeLog.info("Legacy callback received", {
    ip: callbackData.ip,
    body_keys: Object.keys(callbackData.body),
  });

  res.status(200).json({
    success: true,
    message: "Callback received successfully",
    id: callbacks.length,
  });
});

// Legacy callback endpoint (for backwards compatibility)
app.post("/callback", generalLimiter, (req, res) => {
  // Validate callback body size
  if (!req.body || Object.keys(req.body).length === 0) {
    return res
      .status(400)
      .json({ success: false, message: "Empty callback body" });
  }

  const callbackData = {
    receivedAt: new Date().toISOString(),
    body: req.body,
    headers: req.headers,
    ip: req.ip,
  };

  callbacks.push(callbackData);
  safeLog.info("Legacy callback received", {
    ip: callbackData.ip,
    body_keys: Object.keys(callbackData.body),
  });

  res.status(200).json({
    success: true,
    message: "Callback received successfully",
    id: callbacks.length,
  });
});
app.post("/v1/get-user", async (req, res) => {
  try {
    const { user } = req.body;
    const usersResponse = await fetch(
      `http://localhost:8379/api/users?page=1&limit=50&search=${encodeURIComponent(user)}`,
      {
        method: "GET",
        headers: {
          accept: "*/*",
          "accept-language": "vi,en-US;q=0.9,en;q=0.8",
        },
      },
    );

    if (!usersResponse.ok) {
      const errorText = await usersResponse.text();
      safeLog.error("User service returned error", {
        status: usersResponse.status,
        body: errorText,
      });
      return res
        .status(502)
        .json({ success: false, message: "Failed to fetch user data" });
    }

    const usersData = await usersResponse.json();
    const resUser = usersData.items?.[0];

    if (!resUser) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    res.status(200).json({
      success: true,
      id: resUser.id,
    });
  } catch (err) {
    safeLog.error("Failed to fetch user", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Start server
app.listen(PORT, async () => {
  try {
    await testDbConnection();
  } catch (err) {
    safeLog.error("Database connection failed on startup", err);
  }

  safeLog.info("Server started", {
    port: PORT,
    env: process.env.NODE_ENV || "development",
    defaultTopupStatus: DEFAULT_TOPUP_STATUS,
  });
  console.log(`
╔════════════════════════════════════════════════╗
║   Payment Callback Server Started             ║
╠════════════════════════════════════════════════╣
║   Server running on: http://localhost:${PORT}     ║
║   Environment: ${(process.env.NODE_ENV || "development").padEnd(29)}║
║                                                ║
║   ENDPOINTS:                                   ║
║   GET  /health                  - Health check ║
║   POST /v1/orders               - Create order ║
║   GET  /v1/orders/:orderId/status - Check order status ║
║   POST /webhook/sepay           - SePay webhook║
║   POST /callback                - Legacy call  ║
╚════════════════════════════════════════════════╝
  `);
});
