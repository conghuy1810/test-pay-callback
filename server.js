const express = require('express');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 5730;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Logs for callback requests
const callbacks = [];

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Callback endpoint
app.post('/callback', (req, res) => {
  const callbackData = {
    receivedAt: new Date().toISOString(),
    body: req.body,
    headers: req.headers,
    ip: req.ip
  };

  callbacks.push(callbackData);
  console.log('✓ Callback received:', callbackData);

  // Return success response
  res.status(200).json({
    success: true,
    message: 'Callback received successfully',
    id: callbacks.length
  });
});

// Endpoint to view all received callbacks
app.get('/callbacks', (req, res) => {
  res.json({
    total: callbacks.length,
    callbacks: callbacks
  });
});

// Endpoint to view specific callback
app.get('/callbacks/:id', (req, res) => {
  const id = parseInt(req.params.id) - 1;
  if (id >= 0 && id < callbacks.length) {
    res.json(callbacks[id]);
  } else {
    res.status(404).json({ error: 'Callback not found' });
  }
});

// Clear all callbacks
app.delete('/callbacks', (req, res) => {
  const count = callbacks.length;
  callbacks.length = 0;
  res.json({ message: `Cleared ${count} callbacks` });
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
║   Receive callback: POST /callback            ║
║   View callbacks: GET /callbacks              ║
║   View callback: GET /callbacks/:id           ║
║   Clear callbacks: DELETE /callbacks          ║
╚════════════════════════════════════════════════╝
  `);
});
