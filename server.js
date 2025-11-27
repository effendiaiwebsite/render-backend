// ESP32 Status Monitor - Backend Server
// Deploy this to Render.com

const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize SQLite database
// IMPORTANT: On Render free tier, the filesystem is EPHEMERAL
// This means data is LOST when the service restarts or spins down
// For persistent storage, use PostgreSQL (see DATABASE_OPTIONS.md)

// Try to use persistent location, but it will still be lost on restart on free tier
const db = new sqlite3.Database('monitor.db', (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Database connected (NOTE: Data will be lost on service restart on free tier)');
  }
});

// Create tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS status_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    status TEXT NOT NULL,
    uptime_seconds INTEGER,
    ip_address TEXT,
    rssi INTEGER,
    free_heap INTEGER,
    is_boot INTEGER,
    timestamp INTEGER,
    server_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,
    last_seen DATETIME,
    total_uptime INTEGER DEFAULT 0,
    status TEXT DEFAULT 'offline'
  )`);
});

// API Endpoint: Receive status updates from ESP32
app.post('/api/status', (req, res) => {
  const data = req.body;
  
  console.log('Received status update:', data);
  
  // Insert status update
  const stmt = db.prepare(`INSERT INTO status_updates 
    (device_id, status, uptime_seconds, ip_address, rssi, free_heap, is_boot, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  
  stmt.run(
    data.device_id || 'unknown',
    data.status || 'online',
    data.uptime_seconds || 0,
    data.ip_address || '',
    data.rssi || 0,
    data.free_heap || 0,
    data.is_boot ? 1 : 0,
    data.timestamp || Date.now()
  );
  stmt.finalize();
  
  // Check if device was offline and just came back online
  db.get(`SELECT status FROM devices WHERE device_id = ?`, [data.device_id || 'unknown'], (err, device) => {
    if (!err && device && device.status === 'offline') {
      console.log(`✅ Device ${data.device_id} came back ONLINE at ${new Date().toISOString()}`);
    }
  });
  
  // Update device record
  const deviceStmt = db.prepare(`INSERT OR REPLACE INTO devices 
    (device_id, last_seen, status) VALUES (?, CURRENT_TIMESTAMP, ?)`);
  deviceStmt.run(data.device_id || 'unknown', data.status || 'online');
  deviceStmt.finalize();
  
  res.json({ success: true, message: 'Status received' });
});

// API Endpoint: Get current device status
app.get('/api/status', (req, res) => {
  db.get(`SELECT * FROM devices ORDER BY last_seen DESC LIMIT 1`, (err, device) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    if (!device) {
      return res.json({ status: 'offline', message: 'No device data' });
    }
    
    // Check if device is online (seen in last 1 minute)
    const lastSeen = new Date(device.last_seen);
    const now = new Date();
    const minutesSinceLastSeen = (now - lastSeen) / 1000 / 60;
    
    const isOnline = minutesSinceLastSeen < 1;
    
    // Log offline event if device just went offline
    if (!isOnline && device.status === 'online') {
      console.log(`⚠️ Device ${device.device_id} went OFFLINE at ${now.toISOString()}`);
      // Update device status to offline
      db.run(`UPDATE devices SET status = 'offline' WHERE device_id = ?`, [device.device_id]);
    }
    
    // Get latest status update
    db.get(`SELECT * FROM status_updates 
            WHERE device_id = ? 
            ORDER BY server_timestamp DESC LIMIT 1`, 
            [device.device_id], (err, latest) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      
      res.json({
        device_id: device.device_id,
        status: isOnline ? 'online' : 'offline',
        last_seen: device.last_seen,
        minutes_since_last_seen: Math.round(minutesSinceLastSeen * 10) / 10,
        latest_update: latest || null
      });
    });
  });
});

// API Endpoint: Get status history
app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  
  db.all(`SELECT * FROM status_updates 
          ORDER BY server_timestamp DESC 
          LIMIT ?`, [limit], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    // Add offline markers between gaps
    const processedRows = [];
    for (let i = 0; i < rows.length; i++) {
      processedRows.push(rows[i]);
      if (i < rows.length - 1) {
        const current = new Date(rows[i].server_timestamp);
        const next = new Date(rows[i + 1].server_timestamp);
        const gapMinutes = (current - next) / 1000 / 60;
        
        // If gap is more than 1 minute, add offline marker
        if (gapMinutes > 1) {
          processedRows.push({
            id: `offline_${i}`,
            device_id: rows[i].device_id,
            status: 'offline',
            server_timestamp: new Date(current.getTime() - gapMinutes * 60 * 1000 / 2).toISOString(),
            is_offline_marker: true
          });
        }
      }
    }
    res.json(processedRows.reverse()); // Reverse to show chronological order
  });
});

// API Endpoint: Get uptime statistics
app.get('/api/stats', (req, res) => {
  db.all(`SELECT 
    COUNT(*) as total_updates,
    MIN(server_timestamp) as first_seen,
    MAX(server_timestamp) as last_seen,
    SUM(CASE WHEN is_boot = 1 THEN 1 ELSE 0 END) as boot_count
    FROM status_updates`, (err, stats) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(stats[0] || {});
  });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Background task: Check for offline devices every minute
setInterval(() => {
  db.all(`SELECT * FROM devices`, (err, devices) => {
    if (err) {
      console.error('Error checking devices:', err);
      return;
    }
    
    devices.forEach(device => {
      const lastSeen = new Date(device.last_seen);
      const now = new Date();
      const minutesSinceLastSeen = (now - lastSeen) / 1000 / 60;
      
      // If no update in 1+ minute and currently marked as online, mark as offline
      if (minutesSinceLastSeen >= 1 && device.status === 'online') {
        console.log(`⚠️ Device ${device.device_id} detected OFFLINE (no update for ${Math.round(minutesSinceLastSeen)} minutes)`);
        db.run(`UPDATE devices SET status = 'offline' WHERE device_id = ?`, [device.device_id]);
        
        // Insert offline marker into status_updates for graph
        db.run(`INSERT INTO status_updates 
                (device_id, status, uptime_seconds, ip_address, rssi, free_heap, is_boot, timestamp, server_timestamp)
                VALUES (?, 'offline', 0, '', 0, 0, 0, ?, CURRENT_TIMESTAMP)`,
                [device.device_id, Date.now()], (err) => {
          if (err) console.error('Error inserting offline marker:', err);
        });
      }
    });
  });
}, 60000); // Check every 60 seconds (1 minute)

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access the dashboard at: http://localhost:${PORT}`);
  console.log(`Offline detection: Checking every 60 seconds`);
});

