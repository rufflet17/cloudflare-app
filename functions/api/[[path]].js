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

  // AIモデル取得API
  if (path === "/get-models" && method === "GET") {
    return handleGetModels(context);
  }
  // 音声合成API
  if (path === "/synthesize" && method === "POST") {
    return handleSynthesize(context);
  }
  // データ操作関連API
  if (path.startsWith("/api/")) {
    return handleApiRoutes(context);
  }

  // 上記に一致しない場合は、Pagesのアセットを返す
  return context.next();
}

// --- /get-models ハンドラー ---
async function handleGetModels({ env }) {
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/ai/models/search?task=text-to-speech`,
      {
        headers: {
          Authorization: `Bearer ${env.API_TOKEN}`,
        },
      }
    );
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Failed to fetch models from Cloudflare API:", errorText);
      throw new Error(`Cloudflare API error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    const models = data.result.map(model => ({
        id: model.name,
        name: model.name.split('/').pop()
    }));
    return new Response(JSON.stringify(models), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in handleGetModels:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch models." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
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

            results.push({
                status: 'success',
                text: text,
                audio_base_64: base64,
                content_type: contentType
            });

        } catch (e) {
            console.error(`Error synthesizing text: "${text}"`, e);
            results.push({
                status: 'error',
                text: text,
                reason: e.message || 'Unknown synthesis error'
            });
        }
    }
    
    return new Response(JSON.stringify(results), {
        headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error("Error in handleSynthesize:", error);
    return new Response(JSON.stringify({ error: "Failed to synthesize audio." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// --- /api/* ルートのメインハンドラ ---
async function handleApiRoutes(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    let decodedToken = null;

    // 保護対象APIのリスト
    const protectedRoutes = [
        { path: '/api/upload', method: 'POST' },
        { path: '/api/delete/', method: 'DELETE', startsWith: true },
        { path: '/api/profile', method: 'ANY' }, // プロフィールAPIは全メソッドを保護
    ];

    const isProtectedRoute = protectedRoutes.some(route => {
        const pathMatch = route.startsWith ? path.startsWith(route.path) : path === route.path;
        const methodMatch = route.method === 'ANY' || route.method === method;
        return pathMatch && methodMatch;
    });

    const filter = url.searchParams.get('filter');
    const needsAuthForFilter = (path === '/api/list' && filter === 'mine');

    if (isProtectedRoute || needsAuthForFilter) {
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
        return handleUpload(request, env, decodedToken);
    }
    if (path.startsWith('/api/delete/') && method === 'DELETE') {
        const key = decodeURIComponent(url.pathname.substring('/api/delete/'.length));
        return handleLogicalDelete(request, env, decodedToken, key);
    }
    if (path === '/api/list' && method === 'GET') {
        return handleList(request, env, decodedToken);
    }
    if (path.startsWith('/api/get/') && method === 'GET') {
        const key = decodeURIComponent(url.pathname.substring('/api/get/'.length));
        return handleGet(request, env, key);
    }
    if (path === '/api/profile') {
        return handleProfile(request, env, decodedToken);
    }

    return new Response("API Route Not Found", { status: 404 });
}


// --- ミュート（地獄BAN）処理 ---
/**
 * ユーザーがミュート（地獄BAN）されているかチェックし、対象であればダミーの成功レスポンスを返す。
 * @param {string} userId - チェック対象のユーザーID
 * @param {object} env - Cloudflare環境変数
 * @returns {Response | null} - ミュート対象であればResponseオブジェクト、対象でなければnull
 */
async function handleHellbanning(userId, env) {
    try {
        const stmt = env.MY_D1_DATABASE.prepare(`SELECT is_muted FROM user_status WHERE user_id = ?`);
        const userStatus = await stmt.bind(userId).first();

        if (userStatus && userStatus.is_muted === 1) {
            // ミュートされている場合、D1/R2への書き込みは行わず、ダミーの成功レスポンスを返す
            console.log(`Hellbanning user: ${userId}`);
            return new Response(JSON.stringify({
                success: true,
                key: `dummy-hellban-${crypto.randomUUID()}` // キーもダミー
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        // ミュートされていない場合はnullを返し、通常の処理を続行させる
        return null;
    } catch (error) {
        console.error("Hellbanning check failed:", error);
        // このチェックでエラーが発生した場合は、安全のために通常の処理に進める
        return null;
    }
}

// --- 個別のAPI実装 ---

async function handleUpload(request, env, decodedToken) {
    if (!decodedToken || !decodedToken.sub) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    const user = { uid: decodedToken.sub };

    // --- ここからが変更点 ---
    // 1. まず地獄BANのチェックを行う
    const hellbanResponse = await handleHellbanning(user.uid, env);
    if (hellbanResponse) {
        // もし`handleHellbanning`がResponseオブジェクトを返した場合（＝ミュート対象だった場合）、
        // そのダミーレスポンスをそのまま返し、以降の処理を中断する。
        return hellbanResponse;
    }
    // --- ここまでが変更点 ---

    try {
        // 2. 次に通常のブロック状態をチェック (これは変更なし)
        const stmt = env.MY_D1_DATABASE.prepare(`SELECT is_blocked FROM user_status WHERE user_id = ?`);
        const userStatus = await stmt.bind(user.uid).first();
        if (userStatus && userStatus.is_blocked === 1) {
            return new Response(JSON.stringify({ error: "あなたのアカウントは投稿が制限されています。" }), { status: 403 });
        }
        
        // 3. 通常のアップロード処理 (これは変更なし)
        const { modelId, text, audioBase64, contentType } = await request.json();
        if (!modelId || !text || !audioBase64 || !contentType) {
            return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400 });
        }
        
        const audioData = atob(audioBase64);
        const arrayBuffer = new Uint8Array(audioData.length);
        for (let i = 0; i < audioData.length; i++) arrayBuffer[i] = audioData.charCodeAt(i);

        const extension = contentType.split('/')[1] || 'bin';
        const r2Key = `${user.uid}/${crypto.randomUUID()}.${extension}`;
        
        await env.MY_R2_BUCKET.put(r2Key, arrayBuffer, { httpMetadata: { contentType } });

        const d1Key = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        
        const { success } = await env.MY_D1_DATABASE.prepare(
            `INSERT INTO audios (id, r2_key, user_id, model_name, text_content, created_at, is_deleted) VALUES (?, ?, ?, ?, ?, ?, 0)`
        ).bind(d1Key, r2Key, user.uid, modelId, text, createdAt).run();

        if (!success) {
            await env.MY_R2_BUCKET.delete(r2Key);
            throw new Error("Failed to write metadata to D1.");
        }

        return new Response(JSON.stringify({ success: true, key: r2Key }), { status: 200, headers: { 'Content-Type': 'application/json' }});
    } catch (error) {
        console.error("Upload failed:", error);
        return new Response(JSON.stringify({ error: "Upload failed." }), { status: 500, headers: { 'Content-Type': 'application/json' }});
    }
}

async function handleList(request, env, decodedToken) {
    try {
        const url = new URL(request.url);
        const params = url.searchParams;
        const limit = 10;
        const page = parseInt(params.get('page') || '1', 10);
        const MAX_PAGE = 100;

        if (isNaN(page) || page < 1 || page > MAX_PAGE) {
            return new Response(JSON.stringify({ error: "無効なページ番号です。" }), { status: 400 });
        }

        const filter = params.get('filter');
        const modelId = params.get('modelId');
        const searchText = params.get('searchText');
        const userId = params.get('userId');
        const offset = (page - 1) * limit;

        let conditions = ["a.is_deleted = 0"];
        let bindings = [];

        if (userId) {
            conditions.push("a.user_id = ?");
            bindings.push(userId);
        } else if (filter === 'mine') {
            if (!decodedToken || !decodedToken.sub) {
                return new Response(JSON.stringify({ error: "このフィルターには認証が必要です。" }), { status: 401 });
            }
            conditions.push("a.user_id = ?");
            bindings.push(decodedToken.sub);
        }

        if (modelId) {
            conditions.push("a.model_name = ?");
            bindings.push(modelId);
        }
        if (searchText) {
            conditions.push("a.text_content LIKE ?");
            bindings.push(`%${searchText}%`);
        }

        const whereClause = `WHERE ${conditions.join(' AND ')}`;

        const query = `
            SELECT
                a.r2_key,
                a.user_id,
                a.model_name,
                a.text_content,
                a.created_at,
                p.username
            FROM audios AS a
            LEFT JOIN user_profiles AS p ON a.user_id = p.user_id
            ${whereClause}
            ORDER BY a.created_at DESC
            LIMIT ? OFFSET ?
        `;
        bindings.push(limit, offset);

        const { results } = await env.MY_D1_DATABASE.prepare(query).bind(...bindings).all();
        
        return new Response(JSON.stringify(results || []), {
            headers: { "Content-Type": "application/json" },
        });
    } catch (error) {
        console.error("List failed:", error);
        return new Response(JSON.stringify({ error: "Failed to list audio files." }), { status: 500 });
    }
}

async function handleGet(request, env, key) {
    try {
        const stmt = env.MY_D1_DATABASE.prepare("SELECT id FROM audios WHERE r2_key = ? AND is_deleted = 0");
        const d1_entry = await stmt.bind(key).first();
        
        if (!d1_entry) {
            return new Response("Object Not Found", { status: 404 });
        }

        const object = await env.MY_R2_BUCKET.get(key);
        if (object === null) {
            return new Response("Object Not Found in R2", { status: 404 });
        }
        
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        return new Response(object.body, { headers });
    } catch (error) {
        console.error("Get failed:", error);
        return new Response(JSON.stringify({ error: "Failed to get audio file." }), { status: 500 });
    }
}

async function handleLogicalDelete(request, env, decodedToken, key) {
    if (!decodedToken || !decodedToken.sub) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    const user = { uid: decodedToken.sub };

    try {
        const stmt = env.MY_D1_DATABASE.prepare(
            `UPDATE audios 
             SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP 
             WHERE r2_key = ? AND user_id = ? AND is_deleted = 0`
        );
        const { meta } = await stmt.bind(key, user.uid).run();

        if (meta.changes === 0) {
            return new Response(JSON.stringify({ error: "File not found or access denied." }), { status: 404 });
        }
        
        return new Response(JSON.stringify({ success: true, key: key }), { status: 200, headers: { 'Content-Type': 'application/json' }});
    } catch (error) {
        console.error("Logical delete failed:", error);
        return new Response(JSON.stringify({ error: "Failed to delete audio file." }), { status: 500 });
    }
}

async function handleProfile(request, env, decodedToken) {
    // decodedToken は isProtectedRoute のチェックで検証済み
    const userId = decodedToken.sub;

    if (request.method === 'GET') {
        const stmt = env.MY_D1_DATABASE.prepare(
            `SELECT username FROM user_profiles WHERE user_id = ?`
        );
        const profile = await stmt.bind(userId).first();

        if (!profile) {
            return new Response(JSON.stringify({ error: "Profile not found" }), { status: 404 });
        }
        return new Response(JSON.stringify(profile), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.method === 'POST') {
        try {
            const { username } = await request.json();

            if (!username || username.trim().length === 0 || username.length > 20) {
                return new Response(JSON.stringify({ error: "表示名は1文字以上20文字以内で入力してください。" }), { status: 400 });
            }

            const stmt = env.MY_D1_DATABASE.prepare(
                `INSERT INTO user_profiles (user_id, username)
                 VALUES (?, ?)
                 ON CONFLICT(user_id) DO UPDATE SET
                   username = excluded.username`
            );
            await stmt.bind(userId, username.trim()).run();
            
            return new Response(JSON.stringify({ success: true, username: username.trim() }), { status: 200 });

        } catch (e) {
            console.error("Profile update failed:", e);
            return new Response(JSON.stringify({ error: "プロフィールの更新に失敗しました。" }), { status: 500 });
        }
    }

    return new Response('Method Not Allowed', { status: 405 });
}