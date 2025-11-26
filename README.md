# ESP32 Status Monitor - Backend Server

This is the backend server that receives status updates from your ESP32 and provides a web dashboard.

## Deploy to Render.com

### Step 1: Create a GitHub Repository

1. Create a new repository on GitHub
2. Upload all files from the `render_backend` folder
3. Make sure `package.json` and `server.js` are in the root

### Step 2: Deploy on Render

1. Go to [render.com](https://render.com) and sign up/login
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repository
4. Configure:
   - **Name**: `esp32-monitor` (or your choice)
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free tier is fine
5. Click **"Create Web Service"**

### Step 3: Get Your URL

After deployment, Render will give you a URL like:
```
https://esp32-monitor.onrender.com
```

### Step 4: Update ESP32 Code

In `esp32_status_monitor.ino`, update:
```cpp
const char *serverURL = "https://your-app-name.onrender.com/api/status";
```

Replace `your-app-name` with your actual Render app name.

## Local Development

To test locally:

```bash
npm install
npm start
```

Then access: `http://localhost:3000`

## API Endpoints

- `POST /api/status` - Receive status updates from ESP32
- `GET /api/status` - Get current device status
- `GET /api/history` - Get status update history
- `GET /api/stats` - Get statistics
- `GET /` - Web dashboard

## Notes

- Free tier on Render spins down after 15 minutes of inactivity
- First request after spin-down takes ~30 seconds
- For production, consider upgrading to keep it always running
- Database is in-memory (resets on restart) - for persistent storage, use PostgreSQL

