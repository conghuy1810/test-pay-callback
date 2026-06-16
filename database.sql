-- Create database
CREATE DATABASE IF NOT EXISTS payments;
USE payments;

-- Transactions table to store SePay webhook data
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
);

-- Orders table (payment order data)
CREATE TABLE IF NOT EXISTS `order` (
  id INT(11) NOT NULL AUTO_INCREMENT,
  order_no VARCHAR(32) NOT NULL,
  account_id INT(11) NOT NULL,
  amount INT(11) NOT NULL,
  status TINYINT(4) NOT NULL DEFAULT '0',
  channel VARCHAR(32) DEFAULT NULL,
  server_id INT(11) DEFAULT NULL,
  trade_no VARCHAR(32) DEFAULT NULL,
  note VARCHAR(255) DEFAULT NULL,
  create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  update_time DATETIME DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  pay_time DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY `order_no` (`order_no`),
  KEY `idx_account_id` (`account_id`),
  KEY `idx_create_time` (`create_time`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Orders table (example for business logic)
CREATE TABLE webhook_logs (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    transaction_id  BIGINT NOT NULL UNIQUE COMMENT 'ID giao dịch SePay',
    body            JSON   NOT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
