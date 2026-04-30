import 'dotenv/config';
import express from 'express';
import { proxyManager } from './lib/proxy-manager.js';
import cron from 'node-cron';
import admin from 'firebase-admin';
import Ably from 'ably';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const PROXY_SECRET = process.env.PROXY_SECRET;

// Initialize Firebase
if (process.env.FIREBASE_PROJECT_ID) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
    });
}

const db = admin.firestore();

// Initialize Ably
const ably = process.env.ABLY_API_KEY ? new Ably.Realtime(process.env.ABLY_API_KEY) : null;

// Auth Middleware
const auth = (req, res, next) => {
    const secret = req.headers['x-proxy-secret'];
    if (secret !== PROXY_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

// Route: Initialize or reuse a session
app.post('/session/:userId', auth, async (req, res) => {
    const { userId } = req.params;
    const { jarData } = req.body;
    
    let client = await proxyManager.getClient(userId);
    if (!client) {
        client = await proxyManager.createSession(userId, jarData);
    }
    
    res.json({ success: true, cached: !!client });
});

// Route: Proxy request to Schoolista
app.get('/proxy/:userId', auth, async (req, res) => {
    const { userId } = req.params;
    const { path } = req.query; // e.g. /Student/Main.aspx?_sid=123
    
    const client = await proxyManager.getClient(userId);
    if (!client) {
        return res.status(404).json({ error: 'Session not found in RAM. Please re-init.' });
    }

    try {
        const portalRes = await client.get(`${process.env.PORTAL_BASE}${path}`);
        res.send(portalRes.data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Background Sync Task (Every 30 minutes)
cron.schedule('*/30 * * * *', async () => {
    console.log('[Sync] Starting background refresh for active sessions...');
    const activeUsers = Array.from(proxyManager.sessions.keys());
    
    for (const userId of activeUsers) {
        try {
            const client = await proxyManager.getClient(userId);
            // Example: Fetch dashboard to keep session alive and check for updates
            const res = await client.get(`${process.env.PORTAL_BASE}/Student/Main.aspx?_sid=${userId}`);
            
            // Logic to check for "New Grade" or "Balance Change" would go here
            // and then push via Ably
            if (ably) {
                const channel = ably.channels.get(`student-${userId}`);
                await channel.publish('sync', { timestamp: Date.now() });
            }
            
            console.log(`[Sync] Refreshed session for ${userId}`);
        } catch (e) {
            console.error(`[Sync] Failed for ${userId}:`, e.message);
        }
    }
    
    proxyManager.cleanup();
});

// Health check to keep Render awake (use with cron-job.org)
app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, () => {
    console.log(`LCC Hub Proxy running on port ${PORT}`);
});
