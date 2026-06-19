-- Rename legacy order timestamp columns to the new schema names
-- This migration assumes the `orders` table currently has `created_at` and/or `updated_at`.
-- It renames those columns to `created_time` and `updated_time` respectively.

ALTER TABLE `orders`
  CHANGE COLUMN `created_at` `created_time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHANGE COLUMN `updated_at` `updated_time` DATETIME NULL ON UPDATE CURRENT_TIMESTAMP;
