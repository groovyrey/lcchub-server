import 'dotenv/config';
import express from 'express';
import { proxyManager } from './lib/proxy-manager.js';
import cron from 'node-cron';
import admin from 'firebase-admin';
import Ably from 'ably';
import * as cheerio from 'cheerio';
import { encrypt } from './lib/auth.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// Helper: Save updated session back to Firestore
async function saveSessionToFirestore(userId, jar) {
    try {
        const jarJson = JSON.stringify(jar.toJSON());
        const encryptedJar = encrypt(jarJson);
        
        await db.collection('portal_sessions').doc(userId).set({
            encryptedJar,
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
            last_attempt_at: admin.firestore.FieldValue.serverTimestamp(),
            consecutive_failures: 0,
            refresh_lock_until: new Date(0)
        }, { merge: true });
        
        console.log(`[Proxy] Synced cookies back to Firestore for ${userId}`);
    } catch (e) {
        console.error(`[Proxy] Failed to save session to Firestore for ${userId}:`, e.message);
    }
}

// Auth Middleware
const auth = (req, res, next) => {
    const secret = req.headers['x-proxy-secret'];
    if (secret !== PROXY_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

// Route: Update or initialize a session
app.post('/session/:userId', auth, async (req, res) => {
    const { userId } = req.params;
    const { jarData } = req.body;
    
    // Always recreate to ensure the RAM cache has the freshest cookies
    await proxyManager.createSession(userId, jarData);
    
    res.json({ success: true, updated: true });
});

// Route: Proxy request to Schoolista
const proxyHandler = async (req, res) => {
    const { userId } = req.params;
    const { path } = req.query; // e.g. /Student/Main.aspx?_sid=123
    
    const client = await proxyManager.getClient(userId, db);
    if (!client) {
        return res.status(404).json({ error: 'Session not found in RAM. Please re-init.' });
    }

    try {
        const config = {
            headers: {
                'Referer': req.headers['referer'] || `${process.env.PORTAL_BASE}/Student/Main.aspx`,
                'User-Agent': req.headers['user-agent'],
                'Accept': req.headers['accept'],
                'Content-Type': req.headers['content-type']
            }
        };

        let portalRes;
        if (req.method === 'POST') {
            const body = typeof req.body === 'string' ? req.body : new URLSearchParams(req.body).toString();
            portalRes = await client.post(`${process.env.PORTAL_BASE}${path}`, body, config);
        } else if (req.method === 'PUT') {
            portalRes = await client.put(`${process.env.PORTAL_BASE}${path}`, req.body, config);
        } else {
            portalRes = await client.get(`${process.env.PORTAL_BASE}${path}`, config);
        }
        
        res.send(portalRes.data);
    } catch (error) {
        const status = error.response?.status || 500;
        console.error(`[Proxy Error] ${req.method} ${path}:`, error.message);
        res.status(status).json({ error: error.message });
    }
};

app.get('/proxy/:userId', auth, proxyHandler);
app.post('/proxy/:userId', auth, proxyHandler);
app.put('/proxy/:userId', auth, proxyHandler);

// Background Sync Task (Every 30 minutes)
cron.schedule('*/30 * * * *', async () => {
    console.log('[Sync] Starting background refresh for active sessions...');
    const activeUsers = Array.from(proxyManager.sessions.keys());
    
    for (const userId of activeUsers) {
        try {
            const session = proxyManager.sessions.get(userId);
            const client = session.client;
            
            // 1. Refresh Dashboard to keep session alive
            const res = await client.get(`${process.env.PORTAL_BASE}/Student/Main.aspx?_sid=${userId}`);
            const $ = cheerio.load(res.data);

            // 2. Check if we are still logged in
            if (res.data.includes('obtnLogin') || res.data.includes('otbUserID')) {
                console.warn(`[Sync] Session expired for ${userId}. Removing from RAM.`);
                proxyManager.sessions.delete(userId);
                continue;
            }

            // 3. Sync cookies back to Firestore to ensure persistence
            await saveSessionToFirestore(userId, session.jar);

            // 4. Detect "New Grades" by looking at report links
            const currentReports = [];
            $('a').each((_, el) => {
                const text = $(el).text().trim();
                const href = $(el).attr('href');
                if (href && text.startsWith("Grades of")) {
                    currentReports.push({ text, href });
                }
            });

            if (currentReports.length > 0) {
                const studentRef = db.collection('students').doc(userId);
                const studentDoc = await studentRef.get();
                
                if (studentDoc.exists) {
                    const existingReports = studentDoc.data().available_reports || [];
                    
                    // Simple check: if lengths differ or names differ, something is new
                    const isNewReport = currentReports.length > existingReports.length || 
                                       currentReports.some(r => !existingReports.some(er => er.text === r.text));

                    if (isNewReport) {
                        console.log(`[Sync] New academic record detected for ${userId}!`);
                        
                        // Update Firestore
                        await studentRef.update({
                            available_reports: currentReports,
                            updated_at: admin.firestore.FieldValue.serverTimestamp()
                        });

                        // Notify via Ably
                        if (ably) {
                            const channel = ably.channels.get(`student-${userId}`);
                            await channel.publish('new-grade', { 
                                count: currentReports.length,
                                timestamp: Date.now() 
                            });
                        }
                    }
                }
            }
            
            console.log(`[Sync] Completed refresh for ${userId}`);
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
