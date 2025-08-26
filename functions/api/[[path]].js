// functions/_middleware.js

// --- 定数 ---
const ITEMS_PER_CHUNK = 50;
const CDN_CACHE_DURATION_SECONDS = 60 * 60 * 24 * 7; // 7日間

// --- JWT検証用のヘルパー関数 ---
let googlePublicKeys = null;
let keysFetchTime = 0;

async function getGooglePublicKeys() {
    const now = Date.now();
    if (googlePublicKeys && (now - keysFetchTime < 3600 * 1000)) { // 1時間キャッシュ
        return googlePublicKeys;
    }
    const response = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
    if (!response.ok) throw new Error('Failed to fetch Google public keys (JWK)');
    const jwks = await response.json();
    googlePublicKeys = jwks.keys;
    keysFetchTime = now;
    return googlePublicKeys;
}

function base64UrlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) { str += '='; }
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
        const jwk = jwks.keys.find(key => key.kid === header.kid);
        if (!jwk) throw new Error('Public key not found for kid: ' + header.kid);

        const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
        
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
    for (let i = 0, strLen = str.length; i < strLen; i++) { bufView[i] = str.charCodeAt(i); }
    return buf;
}

// --- メインリクエストハンドラー ---
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/get-models" && method === "GET") return handleGetModels(context);
  if (path === "/synthesize" && method === "POST") return handleSynthesize(context);
  if (path.startsWith("/api/")) return handleApiRoutes(context);

  return context.next();
}

// --- /get-models ハンドラー ---
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

// --- /synthesize ハンドラー ---
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

// --- キャッシュパージヘルパー ---
async function purgeCache(context, urlsToPurge) {
    const cache = caches.default;
    for (const url of urlsToPurge) {
        await cache.delete(url);
    }
}

// --- /api/* ルートのメインハンドラ ---
async function handleApiRoutes(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    let decodedToken = null;

    const protectedRoutes = [
        { path: '/api/upload', method: 'POST' },
        { path: '/api/delete/', method: 'DELETE', startsWith: true },
        { path: '/api/profile', method: 'ANY' },
        { path: '/api/my-profile', method: 'GET' },
    ];
    const isProtectedRoute = protectedRoutes.some(route => (route.startsWith ? path.startsWith(route.path) : path === route.path) && (route.method === 'ANY' || route.method === method));
    const needsAuthForFilter = (path === '/api/list' && url.searchParams.get('filter') === 'mine');

    if (isProtectedRoute || needsAuthForFilter) {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) return new Response(JSON.stringify({ error: "認証が必要です。" }), { status: 401 });
        const token = authHeader.substring(7);
        decodedToken = await verifyFirebaseToken(token, env);
        if (!decodedToken) return new Response(JSON.stringify({ error: "トークンが無効です。" }), { status: 403 });
    }

    if (path === '/api/upload' && method === 'POST') return handleUpload(context, decodedToken);
    if (path.startsWith('/api/delete/') && method === 'DELETE') {
        const key = decodeURIComponent(url.pathname.substring('/api/delete/'.length));
        return handleLogicalDelete(context, decodedToken, key);
    }
    if (path === '/api/list' && method === 'GET') return handleList(context, decodedToken);
    if (path.startsWith('/api/get/') && method === 'GET') {
        const key = decodeURIComponent(url.pathname.substring('/api/get/'.length));
        return handleGet(request, env, key);
    }
    if (path === '/api/profile') return handleProfile(request, env, decodedToken);
    if (path === '/api/my-profile' && method === 'GET') return handleMyProfile(request, env, decodedToken);

    return new Response("API Route Not Found", { status: 404 });
}

// --- 個別のAPI実装 ---
async function handleUpload(context, decodedToken) {
    const { request, env } = context;
    if (!decodedToken || !decodedToken.sub) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    const user = { uid: decodedToken.sub };

    try {
        const userStatus = await env.MY_D1_DATABASE.prepare(`SELECT is_blocked, is_muted FROM user_status WHERE user_id = ?`).bind(user.uid).first();
        if (userStatus?.is_blocked === 1) return new Response(JSON.stringify({ error: "あなたのアカウントは投稿が制限されています。", reason: "blocked" }), { status: 403 });
        if (userStatus?.is_muted === 1) return new Response(JSON.stringify({ error: "ミュート状態のため、この音声はテスト投稿として保存されます。", reason: "muted" }), { status: 403 });

        const { modelId, text, audioBase64, contentType } = await request.json();
        if (!modelId || !text || !audioBase64 || !contentType) return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400 });
        
        const audioData = atob(audioBase64);
        const arrayBuffer = new Uint8Array(audioData.length).map((_, i) => audioData.charCodeAt(i));

        const extension = contentType.split('/')[1] || 'bin';
        const r2Key = `${user.uid}/${crypto.randomUUID()}.${extension}`;
        
        await env.MY_R2_BUCKET.put(r2Key, arrayBuffer, { httpMetadata: { contentType } });

        const d1Key = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        
        await env.MY_D1_DATABASE.prepare(`INSERT INTO audios (id, r2_key, user_id, model_name, text_content, created_at, is_deleted) VALUES (?, ?, ?, ?, ?, ?, 0)`).bind(d1Key, r2Key, user.uid, modelId, text, createdAt).run();

        // メタデータ更新とチャンク化をバックグラウンドで実行
        context.waitUntil(updateMetadataAndChunks(context, user.uid, modelId));

        return new Response(JSON.stringify({ success: true, key: r2Key }), { status: 200 });
    } catch (error) {
        console.error("Upload failed:", error);
        return new Response(JSON.stringify({ error: "Upload failed." }), { status: 500 });
    }
}

async function getMetadataKey(params) {
    if (params.get('userId')) return `user_${params.get('userId')}`;
    if (params.get('modelId')) return `model_${params.get('modelId')}`;
    return 'all';
}

async function handleList(context, decodedToken) {
    const { request, env } = context;
    const cache = caches.default;
    const cacheResponse = await cache.match(request);
    if (cacheResponse) return cacheResponse;

    try {
        const url = new URL(request.url);
        const params = url.searchParams;
        const page = parseInt(params.get('page') || '1', 10);
        const limit = parseInt(params.get('limit') || '50', 10);

        if (isNaN(page) || page < 1 || isNaN(limit) || limit < 1 || limit > 50) {
            return new Response(JSON.stringify({ error: "無効なページまたはリミットです。" }), { status: 400 });
        }

        const metadataKey = await getMetadataKey(params);
        const metadata = await env.MY_D1_DATABASE.prepare("SELECT total_items FROM audio_metadata WHERE id = ?").bind(metadataKey).first();
        const totalItems = metadata ? metadata.total_items : 0;
        if (totalItems === 0) return new Response("[]", { headers: { "Content-Type": "application/json" } });

        const offset = (page - 1) * limit;
        const recentItemsCount = totalItems % ITEMS_PER_CHUNK;
        let results = [];

        if (offset < recentItemsCount) { // 最新の未チャンク化データから取得
            let conditions = ["a.is_deleted = 0"];
            let bindings = [];
            // ... (フィルタ条件の構築)
            if (params.get('userId')) { conditions.push("a.user_id = ?"); bindings.push(params.get('userId')); }
            else if (params.get('filter') === 'mine' && decodedToken) { conditions.push("a.user_id = ?"); bindings.push(decodedToken.sub); }
            if (params.get('modelId')) { conditions.push("a.model_name = ?"); bindings.push(params.get('modelId')); }
            if (params.get('searchText')) { conditions.push("a.text_content LIKE ?"); bindings.push(`%${params.get('searchText')}%`); }

            const query = `SELECT a.r2_key, a.user_id, a.model_name, a.text_content, a.created_at, p.username FROM audios AS a LEFT JOIN user_profiles AS p ON a.user_id = p.user_id WHERE ${conditions.join(' AND ')} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`;
            bindings.push(Math.min(limit, recentItemsCount - offset), offset);
            
            const { results: dbResults } = await env.MY_D1_DATABASE.prepare(query).bind(...bindings).all();
            results = dbResults;

        } else { // チャンク化済みデータから取得
            const chunkOffset = offset - recentItemsCount;
            const totalChunks = Math.floor(totalItems / ITEMS_PER_CHUNK);
            const chunkIndex = totalChunks - 1 - Math.floor(chunkOffset / ITEMS_PER_CHUNK);
            
            if (chunkIndex >= 0) {
                const chunkKey = `chunks/${metadataKey}/chunk_${chunkIndex}.json`;
                const chunkObject = await env.MY_R2_BUCKET.get(chunkKey);
                if (chunkObject) {
                    const chunkData = await chunkObject.json();
                    const offsetInChunk = chunkOffset % ITEMS_PER_CHUNK;
                    results = chunkData.slice(offsetInChunk, offsetInChunk + limit);
                }
            }
        }
        
        const response = new Response(JSON.stringify(results || []), { headers: { "Content-Type": "application/json", 'Cache-Control': `public, s-maxage=${CDN_CACHE_DURATION_SECONDS}` } });
        context.waitUntil(cache.put(request, response.clone()));
        return response;

    } catch (error) {
        console.error("List failed:", error);
        return new Response(JSON.stringify({ error: "Failed to list audio files." }), { status: 500 });
    }
}

async function handleGet(request, env, key) {
    try {
        const d1_entry = await env.MY_D1_DATABASE.prepare("SELECT id FROM audios WHERE r2_key = ? AND is_deleted = 0").bind(key).first();
        if (!d1_entry) return new Response("Object Not Found", { status: 404 });

        const object = await env.MY_R2_BUCKET.get(key);
        if (object === null) return new Response("Object Not Found in R2", { status: 404 });
        
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        // R2オブジェクトは長期間キャッシュさせる
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        return new Response(object.body, { headers });
    } catch (error) {
        console.error("Get failed:", error);
        return new Response(JSON.stringify({ error: "Failed to get audio file." }), { status: 500 });
    }
}

async function handleLogicalDelete(context, decodedToken, key) {
    const { request, env } = context;
    if (!decodedToken || !decodedToken.sub) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    const user = { uid: decodedToken.sub };

    try {
        // 削除対象の情報を取得
        const audioInfo = await env.MY_D1_DATABASE.prepare("SELECT user_id, model_name FROM audios WHERE r2_key = ? AND is_deleted = 0").bind(key).first();
        if (!audioInfo || audioInfo.user_id !== user.uid) {
            return new Response(JSON.stringify({ error: "File not found or access denied." }), { status: 404 });
        }
        
        await env.MY_D1_DATABASE.prepare(`UPDATE audios SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE r2_key = ? AND user_id = ?`).bind(key, user.uid).run();

        // メタデータ更新（総数をデクリメント）とキャッシュパージ
        context.waitUntil(decrementMetadataAndPurge(context, user.uid, audioInfo.model_name));
        
        return new Response(JSON.stringify({ success: true, key: key }), { status: 200 });
    } catch (error) {
        console.error("Logical delete failed:", error);
        return new Response(JSON.stringify({ error: "Failed to delete audio file." }), { status: 500 });
    }
}

// --- プロファイルハンドラー (変更なし) ---
async function handleProfile(request, env, decodedToken) {
    const userId = decodedToken.sub;
    if (request.method === 'GET') {
        const profile = await env.MY_D1_DATABASE.prepare(`SELECT username FROM user_profiles WHERE user_id = ?`).bind(userId).first();
        if (!profile) return new Response(JSON.stringify({ error: "Profile not found" }), { status: 404 });
        return new Response(JSON.stringify(profile), { headers: { 'Content-Type': 'application/json' } });
    }
    if (request.method === 'POST') {
        try {
            const { username } = await request.json();
            if (!username || username.trim().length === 0 || username.length > 20) return new Response(JSON.stringify({ error: "表示名は1文字以上20文字以内で入力してください。" }), { status: 400 });
            await env.MY_D1_DATABASE.prepare(`INSERT INTO user_profiles (user_id, username) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET username = excluded.username`).bind(userId, username.trim()).run();
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
        const profile = await env.MY_D1_DATABASE.prepare(`SELECT username FROM user_profiles WHERE user_id = ?`).bind(userId).first();
        const responsePayload = { userId: userId, username: profile ? profile.username : (googleDisplayName || '匿名ユーザー') };
        return new Response(JSON.stringify(responsePayload), { headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
        console.error("Failed to fetch my-profile:", error);
        return new Response(JSON.stringify({ error: "プロファイル情報の取得に失敗しました。" }), { status: 500 });
    }
}

// --- チャンク化とメタデータ更新のコアロジック ---
async function updateMetadataAndChunks(context, userId, modelId) {
    const { env } = context;
    const metadataKeys = ['all', `user_${userId}`, `model_${modelId}`];
    
    for (const key of metadataKeys) {
        const { total_items: newTotalItems } = await env.MY_D1_DATABASE.prepare(
            `INSERT INTO audio_metadata (id, total_items, last_updated) VALUES (?, 1, ?)
             ON CONFLICT(id) DO UPDATE SET total_items = total_items + 1, last_updated = ?
             RETURNING total_items`
        ).bind(key, new Date().toISOString(), new Date().toISOString()).first();
        
        if (newTotalItems > 0 && newTotalItems % ITEMS_PER_CHUNK === 0) {
            await createChunk(env, key, newTotalItems);
        }
    }
    await purgeRelatedCaches(context, userId, modelId);
}

async function decrementMetadataAndPurge(context, userId, modelId) {
    const metadataKeys = ['all', `user_${userId}`, `model_${modelId}`];
    for (const key of metadataKeys) {
        await context.env.MY_D1_DATABASE.prepare(
            `UPDATE audio_metadata SET total_items = total_items - 1, last_updated = ? WHERE id = ?`
        ).bind(new Date().toISOString(), key).run();
    }
    // 削除時はチャンク再生成はせず、キャッシュパージのみ
    await purgeRelatedCaches(context, userId, modelId);
}

async function createChunk(env, metadataKey, totalItems) {
    const chunkIndex = Math.floor(totalItems / ITEMS_PER_CHUNK) - 1;
    if (chunkIndex < 0) return;

    let conditions = ["a.is_deleted = 0"];
    let bindings = [];
    const [type, value] = metadataKey.split('_');
    if (type === 'user') { conditions.push("a.user_id = ?"); bindings.push(value); }
    if (type === 'model') { conditions.push("a.model_name = ?"); bindings.push(value); }

    const offset = totalItems - ITEMS_PER_CHUNK;
    const query = `SELECT a.r2_key, a.user_id, a.model_name, a.text_content, a.created_at, p.username FROM audios AS a LEFT JOIN user_profiles AS p ON a.user_id = p.user_id WHERE ${conditions.join(' AND ')} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`;
    bindings.push(ITEMS_PER_CHUNK, offset);
    
    const { results } = await env.MY_D1_DATABASE.prepare(query).bind(...bindings).all();

    if (results && results.length > 0) {
        const chunkR2Key = `chunks/${metadataKey}/chunk_${chunkIndex}.json`;
        await env.MY_R2_BUCKET.put(chunkR2Key, JSON.stringify(results), {
            httpMetadata: { 
                contentType: 'application/json',
                // チャンクは長期間キャッシュ
                cacheControl: 'public, max-age=31536000, immutable'
            },
        });
    }
}

async function purgeRelatedCaches(context, userId, modelId) {
    // APIのキャッシュをパージする
    //
    // 注意: Cache APIの`delete`は完全なURLマッチングが必要です。
    // クエリパラメータが多岐にわたる場合、この方法は不完全になる可能性があります。
    // その場合は、レスポンスに `Cache-Control: no-cache` を設定するか、
    // Cache Purge by Tag (Enterpriseプラン) の利用を検討します。
    // ここでは、基本的なURLのキャッシュを削除する試みを行います。
    const baseUrl = new URL(context.request.url).origin;
    const urlsToPurge = [
        `${baseUrl}/api/list?limit=50&page=1`,
        `${baseUrl}/api/list?limit=50&page=1&userId=${userId}`,
        `${baseUrl}/api/list?limit=50&page=1&modelId=${encodeURIComponent(modelId)}`,
    ];
    await purgeCache(context, urlsToPurge);
}