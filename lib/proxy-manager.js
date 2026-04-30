import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';

class ProxyManager {
    constructor() {
        this.sessions = new Map(); // userId -> { client, jar, lastAccess }
    }

    async getClient(userId, db = null) {
        if (this.sessions.has(userId)) {
            const session = this.sessions.get(userId);
            session.lastAccess = Date.now();
            return session.client;
        }

        // Auto-rehydrate from Firestore if db is provided
        if (db) {
            try {
                const sessionDoc = await db.collection('portal_sessions').doc(userId).get();
                if (sessionDoc.exists && sessionDoc.data().encryptedJar) {
                    console.log(`[Proxy] Rehydrating session for ${userId} from Firestore...`);
                    const { decrypt } = await import('./auth.js');
                    const decrypted = decrypt(sessionDoc.data().encryptedJar);
                    const jarData = JSON.parse(decrypted);
                    return await this.createSession(userId, jarData);
                }
            } catch (e) {
                console.error(`[Proxy] Rehydration failed for ${userId}:`, e.message);
            }
        }

        return null;
    }

    async createSession(userId, jarData = null) {
        const jar = jarData ? CookieJar.fromJSON(jarData) : new CookieJar();
        const client = wrapper(axios.create({
            jar,
            withCredentials: true,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            },
            timeout: 15000
        }));

        this.sessions.set(userId, {
            client,
            jar,
            lastAccess: Date.now()
        });

        return client;
    }

    // Cleanup old sessions every hour to save RAM on Render Free Tier
    cleanup() {
        const oneHourAgo = Date.now() - (60 * 60 * 1000);
        for (const [userId, session] of this.sessions.entries()) {
            if (session.lastAccess < oneHourAgo) {
                this.sessions.delete(userId);
            }
        }
    }
}

export const proxyManager = new ProxyManager();
