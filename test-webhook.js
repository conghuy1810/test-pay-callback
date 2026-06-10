#!/usr/bin/env node

/**
 * SePay Webhook Test Helper
 * Generate valid HMAC signatures for testing
 */

const crypto = require('crypto');

const SECRET = process.env.SEPAY_WEBHOOK_SECRET || 'test_secret_key';
const API_URL = process.env.API_URL || 'http://localhost:5730/webhook/sepay';

// Sample transaction payload
const payload = {
  id: `TXN-${Date.now()}`, // Unique transaction ID
  gateway: 'vietcombank',
  transactionDate: new Date().toISOString(),
  accountNumber: '0011002244668',
  code: 'ORDER-123',
  transferType: 'in',
  transferAmount: 100000, // VND
  accumulated: 100000,
  content: 'THANH TOAN DON HANG 001',
  referenceCode: 'REF-123'
};

function generateSignature(body, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  
  return { timestamp, signature };
}

function sendWebhook() {
  const body = JSON.stringify(payload);
  const { timestamp, signature } = generateSignature(body, SECRET);

  console.log('\n📋 SePay Webhook Test\n');
  console.log('🔐 Signature Info:');
  console.log(`  Secret: ${SECRET.substring(0, 10)}...`);
  console.log(`  Timestamp: ${timestamp}`);
  console.log(`  Signature: ${signature.substring(0, 20)}...\n`);
  
  console.log('📦 Payload:');
  console.log(`  ${JSON.stringify(payload, null, 2).split('\n').join('\n  ')}\n`);

  console.log('🚀 cURL Command:');
  console.log(`
curl -X POST ${API_URL} \\
  -H "x-sepay-signature: ${signature}" \\
  -H "x-sepay-timestamp: ${timestamp}" \\
  -H "Content-Type: application/octet-stream" \\
  -d '${body}'
  `);

  console.log('\n💡 To test: export SEPAY_WEBHOOK_SECRET="your_secret" && node test-webhook.js\n');
}

sendWebhook();
