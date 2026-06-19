
CREATE TABLE IF NOT EXISTS `orders` (
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

CREATE TABLE `pay` (
  `trade_no` varchar(20) NOT NULL,
  `channel` varchar(10) DEFAULT NULL,
  `server_id` int(11) NOT NULL,
  `account_id` int(11) NOT NULL,
  `fee` int(11) NOT NULL,
  `status` tinyint(4) NOT NULL,
  `create_time` datetime NOT NULL,
  `pay_time` datetime DEFAULT NULL,
  PRIMARY KEY (`trade_no`),
  KEY `trade_no` (`trade_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
