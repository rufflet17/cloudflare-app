// functions/_middleware.js

// btoa/atobはCloudflare Workersのグローバルスコープで利用可能です。

// --- JWT検証用のヘルパー関数 ---
let googlePublicKeys = null;
let keysFetchTime = 0;

async function getGooglePublicKeys() {
    const now = Date.now();
    // 1時間キャッシュを利用
    if (googlePublicKeys && (now - keysFetchTime < 3600 * 1000)) {
        return googlePublicKeys;
    }
    const response = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
    if (!response.ok) {
        throw new Error('Failed to fetch Google public keys (JWK)');
    }
    const jwks = await response.json();
    googlePublicKeys = jwks.keys;
    keysFetchTime = now;
    return googlePublicKeys;
}

function base64UrlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) {
        str += '=';
    }
    return atob(str);
}

async function verifyFirebaseToken(token, env) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) throw new Error('Invalid token structure');
        
        const [headerB64, payloadB64, signatureB64] = parts;
        const header = JSON.parse(base64UrlDecode(headerB64));
        const payload = JSON.parse(base64UrlDecode(payloadB64));

        if (header.alg !== 'RS256') throw new Error('Invalid algorithm. Expected RS256.');

        const now = Math.floor(Date.now() / 1000);
        if (payload.auth_time > now) throw new Error('Token auth_time is in the future.');
        if (payload.iat > now) throw new Error('Token iat is in the future.');
        if (payload.exp < now) throw new Error('Token has expired.');
        
        const firebaseProjectId = env.FIREBASE_PROJECT_ID; 
        if (!firebaseProjectId) throw new Error("FIREBASE_PROJECT_ID is not set in environment variables.");
        
        if (payload.aud !== firebaseProjectId) throw new Error('Invalid audience.');
        if (payload.iss !== `https://securetoken.google.com/${firebaseProjectId}`) throw new Error('Invalid issuer.');
        if (!payload.sub || payload.sub === '') throw new Error('Invalid subject (uid).');

        const jwks = await getGooglePublicKeys();
        const jwk = jwks.find(key => key.kid === header.kid);
        if (!jwk) {
            throw new Error('Public key not found for kid: ' + header.kid);
        }

        const key = await crypto.subtle.importKey(
            'jwk',
            jwk,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify']
        );
        
        const signature = str2ab(base64UrlDecode(signatureB64));
        const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
        
        const isValid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data);

        if (!isValid) throw new Error('Signature verification failed');

        return payload;

    } catch (error) {
        console.error("Token verification failed:", error.name, error.message);
        return null;
    }
}

function str2ab(str) {
    const buf = new ArrayBuffer(str.length);
    const bufView = new Uint8Array(buf);
    for (let i = 0, strLen = str.length; i < strLen; i++) {
        bufView[i] = str.charCodeAt(i);
    }
    return buf;
}

// --- メインリクエストハンドラー ---
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/get-models" && method === "GET") { return handleGetModels(context); }
  if (path === "/synthesize" && method === "POST") { return handleSynthesize(context); }
  if (path.startsWith("/api/")) {
    if (path === '/api/chunk/latest' && method === 'GET') {
        return handleChunkRequest(context, 'latest');
    }
    const chunkMatch = path.match(/^\/api\/chunk\/(\d+)$/);
    if (chunkMatch && method === 'GET') {
        const page = parseInt(chunkMatch[1], 10);
        return handleChunkRequest(context, page);
    }
    return handleOtherApiRoutes(context);
  }

  return context.next();
}

// --- チャンクリクエストのメインハンドラ ---
async function handleChunkRequest(context, chunkIdentifier) {
    const cache = caches.default;
    const { request } = context;
    const cacheKey = new Request(request.url, request);
    let response = await cache.match(cacheKey);

    if (!response) {
        console.log(`Cache miss for chunk: ${chunkIdentifier}`);
        if (chunkIdentifier === 'latest') {
            response = await handleLatestChunk(context);
        } else {
            response = await handleNumberedChunk(context, chunkIdentifier);
        }
        
        if (response.ok) {
            context.waitUntil(cache.put(cacheKey, response.clone()));
        }
    } else {
        console.log(`Cache hit for chunk: ${chunkIdentifier}`);
    }
    return response;
}

// --- 従来のAPIと認証が必要なAPIルート ---
async function handleOtherApiRoutes(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/api/list' && method === 'GET') {
        // ★ MODIFIED: /api/list もキャッシュ対応にする
        return handleListForFilter(context);
    }

    let decodedToken = null;
    const protectedRoutes = [
        { path: '/api/upload', method: 'POST' },
        { path: '/api/delete/', method: 'DELETE', startsWith: true },
        { path: '/api/profile', method: 'ANY' },
        { path: '/api/my-profile', method: 'GET' },
    ];

    const isProtectedRoute = protectedRoutes.some(route => {
        const pathMatch = route.startsWith ? path.startsWith(route.path) : path === route.path;
        const methodMatch = route.method === 'ANY' || route.method === method;
        return pathMatch && methodMatch;
    });

    if (isProtectedRoute) {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return new Response(JSON.stringify({ error: "認証が必要です。" }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        const token = authHeader.substring(7);
        decodedToken = await verifyFirebaseToken(token, env);
        if (!decodedToken) {
            return new Response(JSON.stringify({ error: "トークンが無効です。" }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        }
    }

    if (path === '/api/upload' && method === 'POST') {
        return handleUpload(request, env, decodedToken, context);
    }
    const deleteMatch = path.match(/^\/api\/delete\/(.+)$/);
    if (deleteMatch && method === 'DELETE') {
        const key = decodeURIComponent(deleteMatch[1]);
        return handleLogicalDelete(request, env, decodedToken, key, context);
    }
    const getMatch = path.match(/^\/api\/get\/(.+)$/);
    if (getMatch && method === 'GET') {
        const key = decodeURIComponent(getMatch[1]);
        return handleGet(request, env, key);
    }
    if (path === '/api/profile') {
        return handleProfile(request, env, decodedToken);
    }
    if (path === '/api/my-profile' && method === 'GET') {
        return handleMyProfile(request, env, decodedToken);
    }
    return new Response("API Route Not Found", { status: 404 });
}

// --- API実装 ---
async function handleGetModels({ env }) {
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/ai/models/search?task=text-to-speech`,
      { headers: { Authorization: `Bearer ${env.API_TOKEN}` } }
    );
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Failed to fetch models from Cloudflare API:", errorText);
      throw new Error(`Cloudflare API error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    const models = data.result.map(model => ({ id: model.name, name: model.name.split('/').pop() }));
    return new Response(JSON.stringify(models), { headers: { "Content-Type": "application/json" } });
  } catch (error) {
    console.error("Error in handleGetModels:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch models." }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

async function handleSynthesize({ request, env }) {
  try {
    const { model_id, texts, style_id, style_strength, format } = await request.json();
    if (!model_id || !texts || !Array.isArray(texts)) {
        return new Response(JSON.stringify({ error: "Missing required parameters: model_id, texts (array)." }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const results = [];
    for (const text of texts) {
        try {
            const inputs = { text };
            if (style_id !== undefined && style_strength !== undefined) {
                inputs.speaker = style_id.toString();
                inputs.style_strength = style_strength;
            }
            const response = await env.AI.run(model_id, inputs);
            const arrayBuffer = await new Response(response).arrayBuffer();
            const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
            const contentType = `audio/${format}`;
            results.push({ status: 'success', text: text, audio_base_64: base64, content_type: contentType });
        } catch (e) {
            console.error(`Error synthesizing text: "${text}"`, e);
            results.push({ status: 'error', text: text, reason: e.message || 'Unknown synthesis error' });
        }
    }
    return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error("Error in handleSynthesize:", error);
    return new Response(JSON.stringify({ error: "Failed to synthesize audio." }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

async function handleLatestChunk({ env }) {
    try {
        const totalResult = await env.MY_D1_DATABASE.prepare(`SELECT value FROM counters WHERE name = 'total_audios'`).first();
        const totalAudios = totalResult ? totalResult.value : 0;
        const limit = 50;
        const itemsInLatestChunk = (totalAudios % limit) || (totalAudios > 0 ? limit : 0);
        const latestChunkNumber = Math.ceil(totalAudios / limit) || 1;
        const query = `
            SELECT r2_key, user_id, model_name, text_content, username, created_at
            FROM audios
            WHERE is_deleted = 0 ORDER BY created_at DESC LIMIT ?`;
        const { results } = await env.MY_D1_DATABASE.prepare(query).bind(itemsInLatestChunk).all();
        const payload = {
            metadata: { totalAudios, latestChunkNumber, itemsInChunk: results.length },
            audios: results || []
        };
        const response = new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
        response.headers.set('Cache-Control', 'public, s-maxage=604800'); // 7日
        return response;
    } catch (error) {
        console.error("Failed to handle latest chunk:", error);
        return new Response(JSON.stringify({ error: "Failed to fetch latest chunk." }), { status: 500 });
    }
}

async function handleNumberedChunk({ env }, page) {
    try {
        const limit = 50;
        const totalResult = await env.MY_D1_DATABASE.prepare(`SELECT value FROM counters WHERE name = 'total_audios'`).first();
        const totalAudios = totalResult ? totalResult.value : 0;
        const latestChunkNumber = Math.ceil(totalAudios / limit) || 1;
        if (page >= latestChunkNumber) {
            return new Response(JSON.stringify({ error: "Numbered chunks must be older than the latest chunk." }), { status: 400 });
        }
        const itemsInLatestChunk = (totalAudios % limit) || (totalAudios > 0 ? limit : 0);
        const offset = itemsInLatestChunk + (latestChunkNumber - page - 1) * limit;
        const query = `
            SELECT r2_key, user_id, model_name, text_content, username, created_at
            FROM audios
            WHERE is_deleted = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?`;
        const { results } = await env.MY_D1_DATABASE.prepare(query).bind(limit, offset).all();
        const response = new Response(JSON.stringify(results || []), { headers: { 'Content-Type': 'application/json' } });
        response.headers.set('Cache-Control', 'public, s-maxage=31536000'); // 1年
        return response;
    } catch (error) {
        console.error(`Failed to handle chunk ${page}:`, error);
        return new Response(JSON.stringify({ error: `Failed to fetch chunk ${page}.` }), { status: 500 });
    }
}


// ★ NEW: /api/list の実処理を分離
async function fetchFilteredList(context) {
    const { request, env } = context;
    let decodedToken = null;
    const url = new URL(request.url);
    if (url.searchParams.get('filter') === 'mine') {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) return new Response(JSON.stringify({ error: "認証が必要です。" }), { status: 401 });
        const token = authHeader.substring(7);
        decodedToken = await verifyFirebaseToken(token, env);
        if (!decodedToken) return new Response(JSON.stringify({ error: "トークンが無効です。" }), { status: 403 });
    }

    try {
        const params = url.searchParams;
        const limit = parseInt(params.get('limit') || '50', 10);
        const page = parseInt(params.get('page') || '1', 10);
        const filter = params.get('filter');
        const modelId = params.get('modelId');
        const searchText = params.get('searchText');
        // ★ MODIFIED: 他ユーザー表示機能を復活
        const userId = params.get('userId');
        const offset = (page - 1) * limit;

        let conditions = ["a.is_deleted = 0"];
        let bindings = [];

        // ★ MODIFIED: 他ユーザー表示機能を復活
        if (userId) { conditions.push("a.user_id = ?"); bindings.push(userId); }
        else if (filter === 'mine') { conditions.push("a.user_id = ?"); bindings.push(decodedToken.sub); }
        if (modelId) { conditions.push("a.model_name = ?"); bindings.push(modelId); }
        if (searchText) { conditions.push("a.text_content LIKE ?"); bindings.push(`%${searchText}%`); }

        const whereClause = `WHERE ${conditions.join(' AND ')}`;
        const query = `
            SELECT a.r2_key, a.user_id, a.model_name, a.text_content, a.username, a.created_at
            FROM audios AS a
            ${whereClause} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`;
        bindings.push(limit, offset);

        const { results } = await env.MY_D1_DATABASE.prepare(query).bind(...bindings).all();
        return new Response(JSON.stringify(results || []), { headers: { "Content-Type": "application/json" } });
    } catch (error) {
        console.error("List (for filter) failed:", error);
        return new Response(JSON.stringify({ error: "Failed to list filtered audio files." }), { status: 500 });
    }
}

// ★ MODIFIED: /api/list もキャッシュ対応
async function handleListForFilter(context) {
    const cache = caches.default;
    const { request } = context;
    const cacheKey = new Request(request.url, request);
    let response = await cache.match(cacheKey);

    if (!response) {
        console.log(`Cache miss for filtered list: ${request.url}`);
        response = await fetchFilteredList(context); // 実処理を呼び出し
        if (response.ok) {
            response.headers.set('Cache-Control', 'public, s-maxage=604800'); // 7日間キャッシュ
            context.waitUntil(cache.put(cacheKey, response.clone()));
        }
    } else {
        console.log(`Cache hit for filtered list: ${request.url}`);
    }
    return response;
}


// ★ NEW: キャッシュを削除するヘルパー関数
async function purgeCaches(context, { modelId, userId }) {
    const { request } = context;
    const cache = caches.default;
    const origin = new URL(request.url).origin;

    const urlsToPurge = [
        `${origin}/api/chunk/latest`,
    ];

    if (modelId) {
        const modelUrl = new URL(`${origin}/api/list`);
        modelUrl.searchParams.set('modelId', modelId);
        modelUrl.searchParams.set('page', '1');
        modelUrl.searchParams.set('limit', '50'); // フロントエンドのクエリに合わせる
        urlsToPurge.push(modelUrl.toString());
    }
    
    if (userId) {
         const userUrl = new URL(`${origin}/api/list`);
         userUrl.searchParams.set('userId', userId);
         userUrl.searchParams.set('page', '1');
         userUrl.searchParams.set('limit', '50');
         urlsToPurge.push(userUrl.toString());
    }
    
    console.log("Purging URLs:", urlsToPurge);
    const purgePromises = urlsToPurge.map(url => cache.delete(new Request(url), { ignoreMethod: true }));
    
    try {
        await Promise.all(purgePromises);
        console.log("Cache purging completed successfully.");
    } catch (err) {
        console.error("Cache purging failed:", err);
    }
}

async function handleUpload(request, env, decodedToken, context) {
    if (!decodedToken || !decodedToken.sub) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    const user = { uid: decodedToken.sub };
    const reqBody = await request.clone().json();

    try {
        const stmt = env.MY_D1_DATABASE.prepare(`SELECT is_blocked, is_muted FROM user_status WHERE user_id = ?`);
        const userStatus = await stmt.bind(user.uid).first();
        if (userStatus) {
            if (userStatus.is_blocked === 1) return new Response(JSON.stringify({ error: "あなたのアカウントは投稿が制限されています。", reason: "blocked" }), { status: 403 });
            if (userStatus.is_muted === 1) return new Response(JSON.stringify({ error: "ミュート状態のため、この音声はテスト投稿として保存されます。", reason: "muted" }), { status: 403 });
        }

        const { modelId, text, username, audioBase64, contentType } = reqBody;
        if (!modelId || !text || !username || typeof username !== 'string' || username.length > 20 || !audioBase64 || !contentType) {
            return new Response(JSON.stringify({ error: "Missing or invalid required fields" }), { status: 400 });
        }
        
        const audioData = atob(audioBase64);
        const arrayBuffer = new Uint8Array(audioData.length);
        for (let i = 0; i < audioData.length; i++) arrayBuffer[i] = audioData.charCodeAt(i);
        const extension = contentType.split('/')[1] || 'bin';
        const r2Key = `${user.uid}/${crypto.randomUUID()}.${extension}`;
        
        await env.MY_R2_BUCKET.put(r2Key, arrayBuffer, { httpMetadata: { contentType } });
        const d1Key = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        
        const batch = [
            env.MY_D1_DATABASE.prepare(`INSERT INTO audios (id, r2_key, user_id, model_name, text_content, username, created_at, is_deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`).bind(d1Key, r2Key, user.uid, modelId, text, username, createdAt),
            env.MY_D1_DATABASE.prepare(`UPDATE counters SET value = value + 1 WHERE name = 'total_audios'`)
        ];
        await env.MY_D1_DATABASE.batch(batch);

        // ★ MODIFIED: 関連するキャッシュをすべて削除
        context.waitUntil(purgeCaches(context, { modelId: modelId, userId: user.uid }));

        return new Response(JSON.stringify({ success: true, key: r2Key }), { status: 200, headers: { 'Content-Type': 'application/json' }});
    } catch (error) {
        console.error("Upload failed:", error);
        return new Response(JSON.stringify({ error: "Upload failed." }), { status: 500 });
    }
}

async function handleGet(request, env, key) {
    try {
        const stmt = env.MY_D1_DATABASE.prepare("SELECT id FROM audios WHERE r2_key = ? AND is_deleted = 0");
        const d1_entry = await stmt.bind(key).first();
        if (!d1_entry) return new Response("Object Not Found", { status: 404 });

        const object = await env.MY_R2_BUCKET.get(key);
        if (object === null) return new Response("Object Not Found in R2", { status: 404 });
        
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        headers.set('Cache-Control', 'public, max-age=31536000');
        return new Response(object.body, { headers });
    } catch (error) {
        console.error("Get failed:", error);
        return new Response(JSON.stringify({ error: "Failed to get audio file." }), { status: 500 });
    }
}

async function handleLogicalDelete(request, env, decodedToken, key, context) {
    // 削除機能は現在フロントエンドから無効化されているが、バックエンドロジックは残しておく
    if (!decodedToken || !decodedToken.sub) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    const user = { uid: decodedToken.sub };

    try {
        const audioInfoStmt = env.MY_D1_DATABASE.prepare(`SELECT model_name, user_id FROM audios WHERE r2_key = ? AND user_id = ? AND is_deleted = 0`);
        const audioInfo = await audioInfoStmt.bind(key, user.uid).first();
        if (!audioInfo) return new Response(JSON.stringify({ error: "File not found or access denied." }), { status: 404 });

        const batch = [
            env.MY_D1_DATABASE.prepare(`UPDATE audios SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE r2_key = ? AND user_id = ? AND is_deleted = 0`).bind(key, user.uid),
            env.MY_D1_DATABASE.prepare(`UPDATE counters SET value = value - 1 WHERE name = 'total_audios'`)
        ];
        const results = await env.MY_D1_DATABASE.batch(batch);
        
        const updateResult = results[0];
        if (updateResult.meta.changes === 0) return new Response(JSON.stringify({ error: "File not found or access denied during transaction." }), { status: 404 });

        // ★ MODIFIED: 削除時も関連キャッシュを削除
        context.waitUntil(purgeCaches(context, { modelId: audioInfo.model_name, userId: audioInfo.user_id }));

        return new Response(JSON.stringify({ success: true, key: key }), { status: 200, headers: { 'Content-Type': 'application/json' }});
    } catch (error) {
        console.error("Logical delete failed:", error);
        return new Response(JSON.stringify({ error: "Failed to delete audio file." }), { status: 500 });
    }
}

async function handleProfile(request, env, decodedToken) {
    const userId = decodedToken.sub;
    if (request.method === 'GET') {
        const stmt = env.MY_D1_DATABASE.prepare(`SELECT username FROM user_profiles WHERE user_id = ?`);
        const profile = await stmt.bind(userId).first();
        if (!profile) return new Response(JSON.stringify({ error: "Profile not found" }), { status: 404 });
        return new Response(JSON.stringify(profile), { headers: { 'Content-Type': 'application/json' } });
    }
    if (request.method === 'POST') {
        try {
            const { username } = await request.json();
            if (!username || username.trim().length === 0 || username.length > 20) return new Response(JSON.stringify({ error: "表示名は1文字以上20文字以内で入力してください。" }), { status: 400 });
            const stmt = env.MY_D1_DATABASE.prepare(`INSERT INTO user_profiles (user_id, username) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET username = excluded.username`);
            await stmt.bind(userId, username.trim()).run();
            return new Response(JSON.stringify({ success: true, username: username.trim() }), { status: 200 });
        } catch (e) {
            console.error("Profile update failed:", e);
            return new Response(JSON.stringify({ error: "プロフィールの更新に失敗しました。" }), { status: 500 });
        }
    }
    return new Response('Method Not Allowed', { status: 405 });
}

async function handleMyProfile(request, env, decodedToken) {
    const userId = decodedToken.sub;
    const googleDisplayName = decodedToken.name || null;
    try {
        const stmt = env.MY_D1_DATABASE.prepare(`SELECT username FROM user_profiles WHERE user_id = ?`);
        const profile = await stmt.bind(userId).first();
        const responsePayload = { userId: userId, username: profile ? profile.username : (googleDisplayName || '匿名ユーザー') };
        return new Response(JSON.stringify(responsePayload), { headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
        console.error("Failed to fetch my-profile:", error);
        return new Response(JSON.stringify({ error: "プロファイル情報の取得に失敗しました。" }), { status: 500 });
    }
}