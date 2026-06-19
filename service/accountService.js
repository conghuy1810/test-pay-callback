const crypto = require("crypto");

class ServiceError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function md5Hex(value) {
  return crypto.createHash("md5").update(String(value)).digest("hex");
}

function normalizeNullableString(value) {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}

function normalizeDate(value) {
  if (value == null || String(value).trim() === "") {
    return null;
  }
  const raw = String(value).trim();
  const ddmmyyyy = /^(\d{2})\/(\d{2})\/(\d{4})$/;
  const yyyymmdd = /^(\d{4})-(\d{2})-(\d{2})$/;

  let year;
  let month;
  let day;
  let match = raw.match(ddmmyyyy);
  if (match) {
    day = match[1];
    month = match[2];
    year = match[3];
    return `${year}-${month}-${day}`;
  }

  match = raw.match(yyyymmdd);
  if (match) {
    return raw;
  }

  return null;
}

function boolToTinyInt(value) {
  return value ? 1 : 0;
}

function defaultString(value, fallback = "") {
  const normalized = value == null ? "" : String(value).trim();
  return normalized === "" ? fallback : normalized;
}

function autoTradeNo() {
  return `ORD${Date.now()}`.slice(0, 20);
}

function autoOrderNo() {
  return `ORD${Date.now()}`.slice(0, 32);
}

class AccountService {
  constructor(pool, config) {
    this.pool = pool;
    this.config = config;
    this.paySchema = null;
  }

  async detectPaySchema() {
    if (this.paySchema) {
      return this.paySchema;
    }

    const [rows] = await this.pool.query("SHOW COLUMNS FROM pay");
    const fields = new Set(rows.map((row) => row.Field));

    this.paySchema = {
      mode: fields.has("trade_no") ? "bridge" : "legacy",
      hasTradeNo: fields.has("trade_no"),
      hasFee: fields.has("fee"),
    };
    return this.paySchema;
  }

  accountSelectQuery() {
    return `
      SELECT
        id, name, question, answer, email, qq, tel, phone, id_type, id_card,
        referrer, point, point_bonus, is_online, is_lock, active, fname, lname,
        permissions, logins, company, sex, birthday, profile_picture, gg_id, fb_id,
        ip, join_date, last_login, last_confirm, email_verified, vericode
      FROM account
    `;
  }

  mapAccountRow(row) {
    return {
      id: row.id,
      username: row.name,
      question: row.question || "",
      answer: row.answer || "",
      email: row.email || "",
      qq: row.qq || "",
      tel: row.tel || "",
      phone: row.phone || "",
      id_type: row.id_type || "",
      id_card: row.id_card || "",
      referrer: row.referrer || "",
      point: row.point || 0,
      point_bonus: row.point_bonus || 0,
      is_online: Boolean(row.is_online),
      is_lock: Boolean(row.is_lock),
      active: Boolean(row.active),
      first_name: row.fname || "",
      last_name: row.lname || "",
      permissions: row.permissions || 0,
      logins: row.logins || 0,
      company: row.company || "",
      sex: row.sex || "",
      birthday: row.birthday || null,
      profile_picture: row.profile_picture || "",
      google_id: row.gg_id || "",
      facebook_id: row.fb_id || "",
      ip: row.ip || "",
      join_date: row.join_date || null,
      last_login: row.last_login || null,
      last_confirm: row.last_confirm || null,
      email_verified: Boolean(row.email_verified),
      vericode: row.vericode || "",
    };
  }

  mapPaymentRow(row) {
    if (Object.prototype.hasOwnProperty.call(row, "trade_no")) {
      return {
        trade_no: row.trade_no,
        channel: row.channel || "",
        server_id: row.server_id,
        account_id: row.account_id,
        account_username: row.account_username || "",
        fee: row.fee,
        status: row.status,
        create_time: row.create_time,
        pay_time: row.pay_time || null,
      };
    }

    return {
      trade_no: row.ref || `PAY-${row.id}`,
      channel: row.chanel || "",
      server_id: row.server,
      account_id: row.recipientid ? Number(row.recipientid) : null,
      account_username: row.accname || "",
      fee: row.amount,
      status: row.type,
      create_time: row.date,
      pay_time: row.date || null,
    };
  }

  mapOrderRow(row) {
    return {
      id: row.id,
      order_no: row.order_no,
      account_id: row.account_id,
      account_username: row.account_username || "",
      amount: row.amount,
      status: row.status,
      channel: row.channel || "",
      server_id: row.server_id,
      trade_no: row.trade_no || "",
      note: row.note || "",
      create_time: row.create_time,
      update_time: row.update_time || null,
      pay_time: row.pay_time || null,
    };
  }

  validateCreateInput(input) {
    const username = String(input.username || "").trim();
    if (!username) {
      throw new ServiceError("invalid_input", "username is required", 400);
    }
    if (!input.password || !input.password2) {
      throw new ServiceError(
        "missing_credential",
        "password and password2 are required",
        400,
      );
    }
  }

  async getAccountById(id) {
    const [rows] = await this.pool.query(
      `${this.accountSelectQuery()} WHERE id = ? LIMIT 1`,
      [id],
    );
    if (!rows.length) {
      throw new ServiceError("not_found", "resource not found", 404);
    }
    return this.mapAccountRow(rows[0]);
  }

  async getAccountByUsername(username) {
    const [rows] = await this.pool.query(
      `${this.accountSelectQuery()} WHERE name = ? LIMIT 1`,
      [String(username).trim()],
    );
    if (!rows.length) {
      throw new ServiceError("not_found", "resource not found", 404);
    }
    return this.mapAccountRow(rows[0]);
  }

  async getAccountByEmail(email) {
    const [rows] = await this.pool.query(
      `${this.accountSelectQuery()} WHERE email = ? LIMIT 1`,
      [String(email).trim()],
    );
    if (!rows.length) {
      throw new ServiceError("not_found", "resource not found", 404);
    }
    return this.mapAccountRow(rows[0]);
  }

  async listAccounts(options = {}) {
    const cappedLimit = Math.min(Math.max(Number(options.limit) || 25, 1), 200);
    const currentPage = Math.max(Number(options.page) || 1, 1);
    const offset = (currentPage - 1) * cappedLimit;
    const normalizedSearch = String(options.search || "").trim();
    const params = [];
    let where = "";

    if (normalizedSearch) {
      const searchLike = `%${normalizedSearch}%`;
      where = " WHERE name LIKE ? OR email LIKE ? OR phone LIKE ?";
      params.push(searchLike, searchLike, searchLike);
    }

    const [items] = await this.pool.query(
      `${this.accountSelectQuery()}${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, cappedLimit, offset],
    );
    const [countRows] = await this.pool.query(
      `SELECT COUNT(*) AS total FROM account${where}`,
      params,
    );
    const total = countRows[0]?.total || 0;
    const totalPages = total > 0 ? Math.ceil(total / cappedLimit) : 0;

    return {
      items: items.map((row) => this.mapAccountRow(row)),
      pagination: {
        page: currentPage,
        limit: cappedLimit,
        total,
        total_pages: totalPages,
        has_prev: currentPage > 1,
        has_next: totalPages > currentPage,
      },
      total,
      limit: cappedLimit,
      page: currentPage,
      total_pages: totalPages,
      search: normalizedSearch,
    };
  }

  async listAllAccounts(options = {}) {
    const cappedLimit = Math.min(Math.max(Number(options.limit) || 25, 1), 200);
    const currentPage = Math.max(Number(options.page) || 1, 1);
    const offset = (currentPage - 1) * cappedLimit;
    const normalizedSearch = String(options.search || "").trim();
    const params = [];
    let where = "";

    if (normalizedSearch) {
      where = " WHERE name = ? OR email = ? OR phone = ?";
      params.push(normalizedSearch, normalizedSearch, normalizedSearch);
    }

    const [items] = await this.pool.query(
      `${this.accountSelectQuery()}${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, cappedLimit, offset],
    );
    const [countRows] = await this.pool.query(
      `SELECT COUNT(*) AS total FROM account${where}`,
      params,
    );
    const total = countRows[0]?.total || 0;
    const totalPages = total > 0 ? Math.ceil(total / cappedLimit) : 0;

    return {
      items: items.map((row) => this.mapAccountRow(row)),
      pagination: {
        page: currentPage,
        limit: cappedLimit,
        total,
        total_pages: totalPages,
        has_prev: currentPage > 1,
        has_next: totalPages > currentPage,
      },
      total,
      limit: cappedLimit,
      page: currentPage,
      total_pages: totalPages,
      search: normalizedSearch,
    };
  }

  async createAccount(input) {
    this.validateCreateInput(input);

    const username = String(input.username).trim();
    const point = input.point == null ? 1500 : Number(input.point);
    const pointBonus =
      input.point_bonus == null ? 0 : Number(input.point_bonus);
    const permissions =
      input.permissions == null ? 0 : Number(input.permissions);
    const logins = input.logins == null ? 0 : Number(input.logins);
    const active = input.active == null ? true : Boolean(input.active);
    const emailVerified =
      input.email_verified == null ? false : Boolean(input.email_verified);

    const query = `
      INSERT INTO account
      (
        name, password, password2, question, answer, email, qq, tel, phone,
        id_type, id_card, referrer, point, point_bonus, is_online, is_lock, active,
        fname, lname, permissions, logins, company, sex, birthday, profile_picture,
        gg_id, fb_id, ip, join_date, last_login, email_verified, vericode
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?, ?)
    `;

    const [result] = await this.pool.execute(query, [
      username,
      md5Hex(input.password),
      md5Hex(input.password2),
      normalizeNullableString(input.question),
      normalizeNullableString(input.answer),
      normalizeNullableString(input.email),
      normalizeNullableString(input.qq),
      normalizeNullableString(input.tel),
      normalizeNullableString(input.phone),
      defaultString(input.id_type, "IdCard"),
      normalizeNullableString(input.id_card),
      normalizeNullableString(input.referrer),
      point,
      pointBonus,
      boolToTinyInt(active),
      defaultString(input.first_name),
      defaultString(input.last_name),
      permissions,
      logins,
      defaultString(input.company),
      defaultString(input.sex),
      normalizeDate(input.birthday),
      normalizeNullableString(input.profile_picture),
      normalizeNullableString(input.google_id),
      normalizeNullableString(input.facebook_id),
      defaultString(input.ip),
      boolToTinyInt(emailVerified),
      defaultString(input.vericode),
    ]);

    return this.getAccountById(result.insertId);
  }

  async updateAccount(id, input) {
    const updates = [];
    const params = [];
    const add = (field, value) => {
      updates.push(`${field} = ?`);
      params.push(value);
    };

    if (input.email !== undefined)
      add("email", String(input.email || "").trim());
    if (input.question !== undefined)
      add("question", String(input.question || "").trim());
    if (input.answer !== undefined)
      add("answer", String(input.answer || "").trim());
    if (input.qq !== undefined) add("qq", String(input.qq || "").trim());
    if (input.tel !== undefined) add("tel", String(input.tel || "").trim());
    if (input.phone !== undefined)
      add("phone", String(input.phone || "").trim());
    if (input.id_type !== undefined)
      add("id_type", defaultString(input.id_type, "IdCard"));
    if (input.id_card !== undefined)
      add("id_card", String(input.id_card || "").trim());
    if (input.referrer !== undefined)
      add("referrer", String(input.referrer || "").trim());
    if (input.point_bonus !== undefined)
      add("point_bonus", Number(input.point_bonus));
    if (input.password !== undefined) add("password", md5Hex(input.password));
    if (input.password2 !== undefined)
      add("password2", md5Hex(input.password2));
    if (input.first_name !== undefined)
      add("fname", defaultString(input.first_name));
    if (input.last_name !== undefined)
      add("lname", defaultString(input.last_name));
    if (input.permissions !== undefined)
      add("permissions", Number(input.permissions));
    if (input.logins !== undefined) add("logins", Number(input.logins));
    if (input.company !== undefined)
      add("company", defaultString(input.company));
    if (input.sex !== undefined) add("sex", defaultString(input.sex));
    if (input.birthday !== undefined)
      add("birthday", normalizeDate(input.birthday));
    if (input.profile_picture !== undefined)
      add("profile_picture", String(input.profile_picture || "").trim());
    if (input.google_id !== undefined)
      add("gg_id", String(input.google_id || "").trim());
    if (input.facebook_id !== undefined)
      add("fb_id", String(input.facebook_id || "").trim());
    if (input.ip !== undefined) add("ip", defaultString(input.ip));
    if (input.active !== undefined)
      add("active", boolToTinyInt(Boolean(input.active)));
    if (input.is_lock !== undefined)
      add("is_lock", boolToTinyInt(Boolean(input.is_lock)));
    if (input.email_verified !== undefined) {
      add("email_verified", boolToTinyInt(Boolean(input.email_verified)));
      if (Boolean(input.email_verified)) {
        updates.push("last_confirm = NOW()");
      }
    }
    if (input.vericode !== undefined)
      add("vericode", defaultString(input.vericode));

    if (!updates.length) {
      return this.getAccountById(id);
    }

    params.push(id);
    const [result] = await this.pool.execute(
      `UPDATE account SET ${updates.join(", ")} WHERE id = ?`,
      params,
    );
    if (!result.affectedRows) {
      throw new ServiceError("not_found", "resource not found", 404);
    }

    return this.getAccountById(id);
  }

  async softDeleteAccount(id) {
    const [result] = await this.pool.execute(
      "UPDATE account SET is_lock = 1, active = 0 WHERE id = ?",
      [id],
    );
    if (!result.affectedRows) {
      throw new ServiceError("not_found", "resource not found", 404);
    }
    return this.getAccountById(id);
  }

  async getPayment(tradeNo) {
    const paySchema = await this.detectPaySchema();
    const query =
      paySchema.mode === "bridge"
        ? 'SELECT trade_no, channel, server_id, account_id, "" AS account_username, fee, status, create_time, pay_time FROM pay WHERE trade_no = ? LIMIT 1'
        : "SELECT id, ref, accname, recipientid, amount, chanel, type, server, date FROM pay WHERE ref = ? LIMIT 1";
    const [rows] = await this.pool.query(query, [tradeNo]);
    if (!rows.length) {
      throw new ServiceError("not_found", "resource not found", 404);
    }
    return this.mapPaymentRow(rows[0]);
  }

  async listRecentPayments(limit = 20) {
    const cappedLimit = Math.max(Number(limit) || 20, 1);
    const paySchema = await this.detectPaySchema();
    const query =
      paySchema.mode === "bridge"
        ? 'SELECT trade_no, channel, server_id, account_id, "" AS account_username, fee, status, create_time, pay_time FROM pay ORDER BY create_time DESC LIMIT ?'
        : "SELECT id, ref, accname, recipientid, amount, chanel, type, server, date FROM pay ORDER BY date DESC LIMIT ?";
    const [rows] = await this.pool.query(query, [cappedLimit]);
    return rows.map((row) => this.mapPaymentRow(row));
  }

  async listPaymentsByAccount(accountId, limit = 20) {
    const cappedLimit = Math.max(Number(limit) || 20, 1);
    const paySchema = await this.detectPaySchema();
    const query =
      paySchema.mode === "bridge"
        ? 'SELECT trade_no, channel, server_id, account_id, "" AS account_username, fee, status, create_time, pay_time FROM pay WHERE account_id = ? ORDER BY create_time DESC LIMIT ?'
        : "SELECT id, ref, accname, recipientid, amount, chanel, type, server, date FROM pay WHERE recipientid = ? OR accname = ? ORDER BY date DESC LIMIT ?";

    const [rows] =
      paySchema.mode === "bridge"
        ? await this.pool.query(query, [accountId, cappedLimit])
        : await this.pool.query(query, [
            String(accountId),
            (await this.getAccountById(accountId)).username,
            cappedLimit,
          ]);

    return rows.map((row) => this.mapPaymentRow(row));
  }

  orderSelectQuery() {
    return `
      SELECT
        o.id, o.order_no, o.account_id, o.amount, o.status, o.channel,
        o.server_id, o.trade_no, o.note, o.pay_time,
        a.name AS account_username
      FROM orders o
      LEFT JOIN account a ON a.id = o.account_id
    `;
  }

  orderSelectQueryById() {
    return `
      SELECT
        o.id, o.order_no, o.account_id, o.amount, o.status, o.channel,
        o.server_id, o.trade_no, o.note, o.pay_time,
        a.name AS account_username
      FROM orders o
      LEFT JOIN account a ON a.id = o.account_id
      WHERE o.id = ?
    `;
  }

  async getOrder(orderNo) {
    const [rows] = await this.pool.query(
      `${this.orderSelectQuery()} WHERE o.order_no = ? LIMIT 1`,
      [String(orderNo).trim()],
    );
    if (!rows.length) {
      throw new ServiceError("not_found", "resource not found", 404);
    }
    return this.mapOrderRow(rows[0]);
  }
  async getOrderId(orderId) {
    const [rows] = await this.pool.query(`${this.orderSelectQueryById()}`, [
      Number(orderId),
    ]);
    if (!rows) {
      throw new ServiceError("not_found", "resource not found", 404);
    }
    return this.mapOrderRow(rows[0]);
  }
  async listOrders(options = {}) {
    const cappedLimit = Math.min(Math.max(Number(options.limit) || 25, 1), 200);
    const currentPage = Math.max(Number(options.page) || 1, 1);
    const offset = (currentPage - 1) * cappedLimit;
    const normalizedSearch = String(options.search || "").trim();
    const params = [];
    let where = "";

    if (normalizedSearch) {
      const searchLike = `%${normalizedSearch}%`;
      where =
        " WHERE o.order_no LIKE ? OR o.trade_no LIKE ? OR a.name LIKE ? OR CAST(o.account_id AS CHAR) LIKE ?";
      params.push(searchLike, searchLike, searchLike, searchLike);
    }

    const [items] = await this.pool.query(
      `${this.orderSelectQuery()}${where} ORDER BY o.create_time DESC LIMIT ? OFFSET ?`,
      [...params, cappedLimit, offset],
    );
    const [countRows] = await this.pool.query(
      `SELECT COUNT(*) AS total FROM orders o LEFT JOIN account a ON a.id = o.account_id${where}`,
      params,
    );
    const total = countRows[0]?.total || 0;
    const totalPages = total > 0 ? Math.ceil(total / cappedLimit) : 0;

    return {
      items: items.map((row) => this.mapOrderRow(row)),
      pagination: {
        page: currentPage,
        limit: cappedLimit,
        total,
        total_pages: totalPages,
        has_prev: currentPage > 1,
        has_next: totalPages > currentPage,
      },
      total,
      limit: cappedLimit,
      page: currentPage,
      total_pages: totalPages,
      search: normalizedSearch,
    };
  }

  async listRecentOrders(limit = 20) {
    const cappedLimit = Math.max(Number(limit) || 20, 1);
    const [rows] = await this.pool.query(
      `${this.orderSelectQuery()} ORDER BY o.create_time DESC LIMIT ?`,
      [cappedLimit],
    );
    return rows.map((row) => this.mapOrderRow(row));
  }

  async listOrdersByAccount(accountId, limit = 20) {
    const cappedLimit = Math.max(Number(limit) || 20, 1);
    const [rows] = await this.pool.query(
      `${this.orderSelectQuery()} WHERE o.account_id = ? ORDER BY o.create_time DESC LIMIT ?`,
      [accountId, cappedLimit],
    );
    return rows.map((row) => this.mapOrderRow(row));
  }

  async createOrderRecord(connection, input) {
    const orderNo = String(input.order_no || autoOrderNo()).trim();
    const status =
      input.status == null
        ? this.config.defaultTopupStatus
        : Number(input.status);
    const payTime = status > 0 ? new Date() : null;

    const createTimeField =
      input.create_time !== undefined
        ? "create_time"
        : input.create_at !== undefined
          ? "create_at"
          : "create_time";
    const createTimeValue =
      input.create_time !== undefined
        ? input.create_time
        : input.create_at !== undefined
          ? input.create_at
          : null;
    const normalizedCreateTime = normalizeNullableString(createTimeValue);

    const columns = [
      "order_no",
      "account_id",
      "amount",
      "status",
      "channel",
      "server_id",
      "trade_no",
      "note",
      createTimeField,
      "pay_time",
    ];

    const placeholders = [
      "?",
      "?",
      "?",
      "?",
      "?",
      "?",
      "?",
      "?",
      normalizedCreateTime ? "?" : "NOW()",
      "?",
    ];

    const params = [
      orderNo,
      Number(input.account_id),
      Number(input.amount),
      status,
      String(input.channel || "").trim(),
      input.server_id == null ? null : Number(input.server_id),
      normalizeNullableString(input.trade_no),
      normalizeNullableString(input.note),
    ];

    if (normalizedCreateTime) {
      params.push(normalizedCreateTime);
    }
    params.push(payTime);

    await connection.execute(
      `INSERT INTO orders (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
      params,
    );

    return orderNo;
  }

  async createOrder(accountId, input) {
    if ((Number(input.amount) || 0) <= 0) {
      throw new ServiceError("invalid_input", "amount must be positive", 400);
    }

    await this.getAccountById(accountId);
    const connection = await this.pool.getConnection();
    let orderNo;

    try {
      await connection.beginTransaction();
      orderNo = await this.createOrderRecord(connection, {
        ...input,
        account_id: accountId,
      });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    return this.getOrder(orderNo);
  }

  async topup(accountId, input) {
    const tradeNo = String(input.trade_no || "").trim();
    if (!tradeNo) {
      throw new ServiceError("invalid_input", "trade_no is required", 400);
    }
    if ((Number(input.server_id) || 0) <= 0 || (Number(input.fee) || 0) <= 0) {
      throw new ServiceError(
        "invalid_input",
        "server_id and fee must be positive",
        400,
      );
    }

    const account = await this.getAccountById(accountId);
    const paySchema = await this.detectPaySchema();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();

      const duplicateQuery =
        paySchema.mode === "bridge"
          ? "SELECT trade_no FROM pay WHERE trade_no = ? LIMIT 1"
          : "SELECT ref FROM pay WHERE ref = ? LIMIT 1";
      const [existing] = await connection.query(duplicateQuery, [tradeNo]);
      if (existing.length) {
        throw new ServiceError(
          "duplicate_trade_no",
          "trade_no already exists",
          409,
        );
      }

      const [update] = await connection.execute(
        "UPDATE account SET point = point + ?, last_confirm = NOW() WHERE id = ? AND active = 1 AND is_lock = 0",
        [Number(input.fee), accountId],
      );
      if (!update.affectedRows) {
        throw new ServiceError("not_found", "resource not found", 404);
      }

      if (paySchema.mode === "bridge") {
        await connection.execute(
          "INSERT INTO pay (trade_no, channel, server_id, account_id, fee, status, create_time, pay_time) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())",
          [
            tradeNo,
            String(input.channel || "").trim(),
            Number(input.server_id),
            accountId,
            Number(input.fee),
            input.status == null
              ? this.config.defaultTopupStatus
              : Number(input.status),
          ],
        );
      } else {
        await connection.execute(
          "INSERT INTO pay (ref, accname, recipientid, seri, code, date, ip, amount, promotion, price, chanel, type, server) VALUES (?, ?, ?, ?, ?, NOW(), ?, ?, 0, ?, ?, ?, ?)",
          [
            tradeNo,
            account.username,
            String(accountId),
            tradeNo,
            tradeNo,
            String(input.ip || ""),
            Number(input.fee),
            Number(input.fee),
            String(input.channel || "").trim(),
            input.status == null
              ? this.config.defaultTopupStatus
              : Number(input.status),
            Number(input.server_id),
          ],
        );
      }

      // await this.createOrderRecord(connection, {
      //   order_no: tradeNo,
      //   account_id: accountId,
      //   amount: Number(input.fee),
      //   status:
      //     input.status == null
      //       ? this.config.defaultTopupStatus
      //       : Number(input.status),
      //   channel: String(input.channel || "").trim(),
      //   server_id: Number(input.server_id),
      //   trade_no: tradeNo,
      //   note: normalizeNullableString(input.note) || "topup",
      // });
      await connection.execute(
        `UPDATE \`orders\` SET status = ?, pay_time = NOW() WHERE id = ?`,
        [input.status || this.config.defaultTopupStatus, input.orderId],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    return {
      payment: await this.getPayment(tradeNo),
      account: await this.getAccountById(accountId),
    };
  }

  async getDashboardSummary(recentLimit = 20) {
    const paySchema = await this.detectPaySchema();
    const [accountSummary] = await this.pool.query(`
      SELECT
        COUNT(*) AS total_accounts,
        SUM(CASE WHEN active = 1 AND is_lock = 0 THEN 1 ELSE 0 END) AS active_accounts,
        SUM(CASE WHEN is_lock = 1 THEN 1 ELSE 0 END) AS locked_accounts,
        SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) AS online_accounts,
        SUM(CASE WHEN active = 0 THEN 1 ELSE 0 END) AS inactive_accounts,
        SUM(CASE WHEN email_verified = 1 THEN 1 ELSE 0 END) AS email_verified_accounts
      FROM account
    `);
    const [topupSummary] = await this.pool.query(
      paySchema.mode === "bridge"
        ? `
          SELECT
            COALESCE(COUNT(*), 0) AS topup_total_count,
            COALESCE(SUM(fee), 0) AS topup_total_fee
          FROM pay
        `
        : `
          SELECT
            COALESCE(COUNT(*), 0) AS topup_total_count,
            COALESCE(SUM(amount), 0) AS topup_total_fee
          FROM pay
        `,
    );
    const [todaySummary] = await this.pool.query(
      paySchema.mode === "bridge"
        ? `
          SELECT
            COALESCE(COUNT(*), 0) AS topup_today_count,
            COALESCE(SUM(fee), 0) AS topup_today_total_fee
          FROM pay
          WHERE DATE(create_time) = CURRENT_DATE()
        `
        : `
          SELECT
            COALESCE(COUNT(*), 0) AS topup_today_count,
            COALESCE(SUM(amount), 0) AS topup_today_total_fee
          FROM pay
          WHERE DATE(date) = CURRENT_DATE()
        `,
    );

    return {
      summary: {
        ...accountSummary[0],
        ...topupSummary[0],
        ...todaySummary[0],
      },
      recent_topups: await this.listRecentPayments(recentLimit),
      recent_orders: await this.listRecentOrders(recentLimit),
    };
  }

  async getDashboardHealth() {
    await this.pool.query("SELECT 1");
    return {
      bridge_status: "ok",
      database_ok: true,
      database_host: this.config.db.host,
      database_port: this.config.db.port,
      server_time: new Date().toISOString(),
    };
  }
}

module.exports = {
  AccountService,
  ServiceError,
  autoTradeNo,
  autoOrderNo,
};
