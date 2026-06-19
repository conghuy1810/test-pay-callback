require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const parseForwarded = require("forwarded-parse");
const joi = require("joi");
const helmet = require("helmet");
const { AccountService, ServiceError } = require("./service/accountService");

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

const accountService = new AccountService(db, {
  defaultTopupStatus: DEFAULT_TOPUP_STATUS,
  db: {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
  },
});

app.set("trust proxy", 1);

// ============================================================================
// RATE LIMITERS
// ============================================================================
// const generalLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 100, // limit each IP to 100 requests per windowMs
//   message: "Too many requests from this IP, please try again later.",
//   standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
//   legacyHeaders: false,
// });

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
// async function main() {
//   const [rows] = await db.execute(
//     "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'orders' ORDER BY ORDINAL_POSITION",
//     [process.env.DB_NAME],
//   );
//   console.table(rows);
// }
// main().catch(console.error);
// const strictLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 phút
//   max: 100, // Giới hạn 100 requests mỗi IP
//   standardHeaders: true,
//   legacyHeaders: false,

//   // 🔥 THÊM ĐOẠN NÀY ĐỂ SỬA TRIỆT ĐỂ LỖI UNKNOWN:
//   keyGenerator: (req) => {
//     // 1. Lấy IP từ header X-Forwarded-For hoặc X-Real-IP do Nginx gửi sang
//     let ip = req.headers["x-forwarded-for"] || req.headers["x-real-ip"];

//     // 2. Nếu Nginx gửi dạng chuỗi danh sách (IP1, IP2), lấy cái đầu tiên
//     if (ip && ip.includes(",")) {
//       ip = ip.split(",")[0];
//     }

//     // 3. Nếu vẫn không lấy được (hoặc bằng 'unknown'), fallback về IP kết nối trực tiếp hoặc chuỗi mặc định
//     if (!ip || ip === "unknown") {
//       ip = req.socket.remoteAddress || "local-fallback-ip";
//     }

//     return ip.trim();
//   },
// });
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
// app.use(generalLimiter);

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
// const SEPAY_ACCOUNT = "26254221";
// const SEPAY_BANK = "ACB";

// vettinbank
const SEPAY_ACCOUNT = "106887462694";
const SEPAY_BANK = "VietinBank";
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

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET;
const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

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

function postForm(url, form) {
  return new Promise((resolve, reject) => {
    const payload = new URLSearchParams(form).toString();
    const req = require("https").request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      },
    );

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function verifyTurnstileToken(token, remoteIp) {
  if (!TURNSTILE_SECRET) {
    throw new Error("TURNSTILE_SECRET is not configured");
  }

  const response = await postForm(TURNSTILE_VERIFY_URL, {
    secret: TURNSTILE_SECRET,
    response: token,
    remoteip: remoteIp || "",
  });

  return response;
}

async function requireTurnstileCaptcha(req, res, next) {
  const token = req.body.turnstileToken;

  if (!token) {
    return res.status(400).json({
      success: false,
      message: "Captcha token is required",
    });
  }

  try {
    const result = await verifyTurnstileToken(token, req.ip);
    if (!result.success) {
      return res.status(403).json({
        success: false,
        message: "Captcha validation failed",
        errors: result["error-codes"] || [],
      });
    }
    next();
  } catch (err) {
    safeLog.error("Turnstile verification failed", err);
    return res.status(500).json({
      success: false,
      message: "Captcha verification error",
    });
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
  // requireTurnstileCaptcha,
  // strictLimiter,
  validateRequest(orderSchema),
  async (req, res) => {
    try {
      const { amount, accountId } = req.body;

      const orderNo =
        `ORD${Date.now()}${crypto.randomBytes(4).toString("hex")}`.slice(0, 32);

      const [result] = await db.execute(
        `INSERT INTO \`orders\` \
          (order_no, account_id, amount, status, channel, server_id, trade_no, note) \
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [orderNo, accountId, amount, 0, "qrCode", 1, null, null],
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
        code: encodedId,
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
      `SELECT id, order_no, account_id, amount, status, pay_time FROM \`orders\` WHERE id = ? LIMIT 1`,
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
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch order status" });
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
      console.log("Received SePay webhook", {
        id: data.id,
        transferType: data.transferType,
        transferAmount: data.transferAmount,
        content: data.content,
      });
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
              `SELECT id, account_id FROM \`orders\` WHERE id = ? LIMIT 1`,
              [orderId],
            );

            if (!orders || orders.length === 0) {
              return res
                .status(404)
                .json({ success: false, message: "Order not found" });
            }

            const order = orders[0];
            const objTrade = {
              account_id: order.account_id,
              fee: Number(cashTrans),
              server_id: "1",
              channel: "qrCode",
              trade_no: description.split(" ")[0],
              status: 1,
              orderId,
            };
            const topupRq = await accountService.topup(
              Number(order.account_id),
              objTrade,
            );
          }
        } catch (err) {
          console.log("Error processing SePay webhook business logic", err);
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
app.post("/v1/get-user", requireTurnstileCaptcha, async (req, res) => {
  try {
    const { user } = req.body;
    const usersResponse = await accountService.listAccounts({
      page: 1,
      limit: 10,
      search: encodeURIComponent(user),
    });

    if (!usersResponse.total || usersResponse.total === 0) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    res.status(200).json({
      success: true,
      users: usersResponse.items,
    });
  } catch (err) {
    safeLog.error("Failed to fetch user", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function handleServiceError(err, res) {
  if (err instanceof ServiceError) {
    return res.status(err.status || 400).json({
      success: false,
      code: err.code,
      message: err.message,
    });
  }
  return false;
}

// API routes for account service
const accountCreateSchema = joi.object({
  username: joi.string().trim().required(),
  password: joi.string().required(),
  password2: joi.string().required(),
  email: joi.string().trim().email().optional(),
  first_name: joi.string().trim().optional().allow(null, ""),
  last_name: joi.string().trim().optional().allow(null, ""),
  company: joi.string().trim().optional().allow(null, ""),
  sex: joi.string().trim().optional().allow(null, ""),
  birthday: joi.string().trim().optional().allow(null, ""),
  point: joi.number().integer().min(0).optional(),
  point_bonus: joi.number().integer().min(0).optional(),
  permissions: joi.number().integer().min(0).optional(),
  logins: joi.number().integer().min(0).optional(),
  active: joi.boolean().optional(),
  email_verified: joi.boolean().optional(),
  vericode: joi.string().trim().optional().allow(null, ""),
});

const accountUpdateSchema = joi
  .object({
    email: joi.string().trim().email().optional(),
    question: joi.string().trim().optional().allow(null, ""),
    answer: joi.string().trim().optional().allow(null, ""),
    qq: joi.string().trim().optional().allow(null, ""),
    tel: joi.string().trim().optional().allow(null, ""),
    phone: joi.string().trim().optional().allow(null, ""),
    id_type: joi.string().trim().optional().allow(null, ""),
    id_card: joi.string().trim().optional().allow(null, ""),
    referrer: joi.string().trim().optional().allow(null, ""),
    point_bonus: joi.number().integer().min(0).optional(),
    password: joi.string().optional(),
    password2: joi.string().optional(),
    first_name: joi.string().trim().optional().allow(null, ""),
    last_name: joi.string().trim().optional().allow(null, ""),
    permissions: joi.number().integer().min(0).optional(),
    logins: joi.number().integer().min(0).optional(),
    company: joi.string().trim().optional().allow(null, ""),
    sex: joi.string().trim().optional().allow(null, ""),
    birthday: joi.string().trim().optional().allow(null, ""),
    profile_picture: joi.string().trim().optional().allow(null, ""),
    google_id: joi.string().trim().optional().allow(null, ""),
    facebook_id: joi.string().trim().optional().allow(null, ""),
    ip: joi.string().trim().optional().allow(null, ""),
    active: joi.boolean().optional(),
    is_lock: joi.boolean().optional(),
    email_verified: joi.boolean().optional(),
    vericode: joi.string().trim().optional().allow(null, ""),
  })
  .min(1);

app.post(
  "/v1/accounts",
  validateRequest(accountCreateSchema),
  asyncHandler(async (req, res) => {
    const account = await accountService.createAccount(req.body);
    res.status(201).json({ success: true, account });
  }),
);

app.get(
  "/v1/accounts",
  asyncHandler(async (req, res) => {
    const result = await accountService.listAccounts(req.query);
    res.json({ success: true, ...result });
  }),
);

app.get(
  "/v1/accounts/:id",
  asyncHandler(async (req, res) => {
    const account = await accountService.getAccountById(Number(req.params.id));
    res.json({ success: true, account });
  }),
);

app.put(
  "/v1/accounts/:id",
  validateRequest(accountUpdateSchema),
  asyncHandler(async (req, res) => {
    const account = await accountService.updateAccount(
      Number(req.params.id),
      req.body,
    );
    res.json({ success: true, account });
  }),
);

app.delete(
  "/v1/accounts/:id",
  asyncHandler(async (req, res) => {
    const account = await accountService.softDeleteAccount(
      Number(req.params.id),
    );
    res.json({ success: true, account });
  }),
);

app.get(
  "/v1/accounts/:id/payments",
  asyncHandler(async (req, res) => {
    const payments = await accountService.listPaymentsByAccount(
      Number(req.params.id),
      Number(req.query.limit || 20),
    );
    res.json({ success: true, items: payments });
  }),
);

app.get(
  "/v1/accounts/:id/orders",
  asyncHandler(async (req, res) => {
    const orders = await accountService.listOrdersByAccount(
      Number(req.params.id),
      Number(req.query.limit || 20),
    );
    res.json({ success: true, items: orders });
  }),
);

app.get(
  "/v1/payments/:tradeNo",
  asyncHandler(async (req, res) => {
    const payment = await accountService.getPayment(req.params.tradeNo);
    res.json({ success: true, payment });
  }),
);

app.get(
  "/v1/payments/recent",
  asyncHandler(async (req, res) => {
    const items = await accountService.listRecentPayments(
      Number(req.query.limit || 20),
    );
    res.json({ success: true, items });
  }),
);

app.get(
  "/v1/orders",
  asyncHandler(async (req, res) => {
    const result = await accountService.listOrders(req.query);
    res.json({ success: true, ...result });
  }),
);

app.get(
  "/v1/orders/recent",
  asyncHandler(async (req, res) => {
    const items = await accountService.listRecentOrders(
      Number(req.query.limit || 20),
    );
    res.json({ success: true, items });
  }),
);

app.post(
  "/v1/accounts/:id/orders",
  asyncHandler(async (req, res) => {
    const order = await accountService.createOrder(
      Number(req.params.id),
      req.body,
    );
    res.status(201).json({ success: true, order });
  }),
);

app.post(
  "/v1/accounts/:id/topups",
  asyncHandler(async (req, res) => {
    const result = await accountService.topup(Number(req.params.id), req.body);
    res.status(201).json({ success: true, ...result });
  }),
);

app.get(
  "/v1/orders/:orderNo",
  asyncHandler(async (req, res) => {
    const order = await accountService.getOrder(req.params.orderNo);
    res.json({ success: true, order });
  }),
);

app.get(
  "/v1/orders/:orderId",
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.orderId);
    const order = await accountService.getOrderId(req.params.orderId);
    res.json({ success: true, order });
  }),
);
app.get(
  "/v1/dashboard/summary",
  asyncHandler(async (req, res) => {
    const result = await accountService.getDashboardSummary(
      Number(req.query.recentLimit || 20),
    );
    res.json({ success: true, ...result });
  }),
);

app.get(
  "/v1/dashboard/health",
  asyncHandler(async (req, res) => {
    const health = await accountService.getDashboardHealth();
    res.json({ success: true, ...health });
  }),
);

app.use((err, req, res, next) => {
  if (handleServiceError(err, res)) {
    return;
  }
  safeLog.error("Unexpected error", err);
  res.status(500).json({ success: false, message: "Internal error" });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});
const ORDERS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS orders (
    id int(11) NOT NULL AUTO_INCREMENT,
    order_no varchar(32) NOT NULL,
    account_id int(11) NOT NULL,
    amount int(11) NOT NULL,
    status tinyint(4) NOT NULL DEFAULT 0,
    channel varchar(32) DEFAULT NULL,
    server_id int(11) DEFAULT NULL,
    trade_no varchar(32) DEFAULT NULL,
    note varchar(255) DEFAULT NULL,
    create_time datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time datetime DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
    pay_time datetime DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY order_no (order_no),
    KEY idx_account_id (account_id),
    KEY idx_create_time (create_time),
    KEY idx_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8
`;

async function ensureOrdersTable(pool) {
  await pool.query(ORDERS_TABLE_SQL);
}
// Start server
app.listen(PORT, async () => {
  try {
    await testDbConnection();
    await ensureOrdersTable();
  } catch (err) {
    safeLog.error("Database startup failed", err);
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
