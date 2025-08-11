// btoaはNode.js環境ではデフォルトで利用できないため、Cloudflare Workersのグローバルスコープで利用可能なことを前提としています。

// --- JWT検証用のヘルパー関数 (ここから) ---

// Googleの公開鍵をキャッシュする変数
let googlePublicKeys = null;
let keysFetchTime = 0;

async function getGooglePublicKeys() {
    const now = Date.now();
    // 1時間キャッシュする
    if (googlePublicKeys && (now - keysFetchTime < 3600 * 1000)) {
        return googlePublicKeys;
    }

    const response = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
    if (!response.ok) {
        throw new Error('Failed to fetch Google public keys');
    }
    googlePublicKeys = await response.json();
    keysFetchTime = now;
    return googlePublicKeys;
}

// Base64URLデコード
function base64UrlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) {
        str += '=';
    }
    // Cloudflare Workersではatobがグローバルで利用可能
    return atob(str);
}

// JWTを検証し、ペイロードを返す関数
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
        
        // ★★★★★ 重要 ★★★★★
        // wrangler.tomlまたはCloudflareダッシュボードの環境変数に `FIREBASE_PROJECT_ID` を設定してください
        const firebaseProjectId = env.FIREBASE_PROJECT_ID; 
        if (!firebaseProjectId) throw new Error("FIREBASE_PROJECT_ID is not set in environment variables.");
        
        if (payload.aud !== firebaseProjectId) throw new Error('Invalid audience.');
        if (payload.iss !== `https://securetoken.google.com/${firebaseProjectId}`) throw new Error('Invalid issuer.');
        if (!payload.sub || payload.sub === '') throw new Error('Invalid subject (uid).');

        const keys = await getGooglePublicKeys();
        const publicKeyPem = keys[header.kid];
        if (!publicKeyPem) {
            throw new Error('Public key not found for kid: ' + header.kid);
        }

        // ★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★
        // ★ 修正済みのコードブロック ★
        // ★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★
        const binaryDer = str2ab(atob(publicKeyPem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\n/g, '')));
        
        const key = await crypto.subtle.importKey(
            'spki',
            binaryDer,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify']
        );
        
        const signature = str2ab(base64UrlDecode(signatureB64));
        const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
        
        const isValid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data);

        if (!isValid) throw new Error('Signature verification failed');

        return payload; // 検証成功

    } catch (error) {
        console.error("Token verification failed:", error.message);
        return null;
    }
}

// Helper for crypto
function str2ab(str) {
    const buf = new ArrayBuffer(str.length);
    const bufView = new Uint8Array(buf);
    for (let i = 0, strLen = str.length; i < strLen; i++) {
        bufView[i] = str.charCodeAt(i);
    }
    return buf;
}
// --- JWT検証用のヘルパー関数 (ここまで) ---


// --- APIハンドラー ---
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // ルーティング
  if (path === "/get-models" && method === "GET") {
    return handleGetModels(context);
  }
  if (path === "/synthesize" && method === "POST") {
    return handleSynthesize(context);
  }
  // /api/ で始まるパスはすべて handleApiRoutes で処理
  if (path.startsWith("/api/")) {
    return handleApiRoutes(context);
  }

  // マッチしない場合は次の処理（静的アセットの配信など）へ
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
        name: model.name.split('/').pop() // モデル名からプレフィックスを除去
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

// --- /api/* ルートの処理 ---
async function handleApiRoutes(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const method = request.method;

    // --- 認証処理 ---
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ error: "Unauthorized: Missing token" }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    
    const token = authHeader.substring(7); // "Bearer " を除去
    const decodedToken = await verifyFirebaseToken(token, env);

    if (!decodedToken) {
        return new Response(JSON.stringify({ error: "Unauthorized: Invalid token" }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    
    // 検証成功！ユーザー情報を取得
    const user = { uid: decodedToken.sub }; // `sub` が Firebase の User ID (uid) です

    // --- ルーティング ---
    if (url.pathname === '/api/upload' && method === 'POST') {
        return handleUpload(request, env, user);
    }
    if (url.pathname === '/api/list' && method === 'GET') {
        return handleList(request, env, user);
    }
    if (url.pathname.startsWith('/api/get/') && method === 'GET') {
        const key = url.pathname.substring('/api/get/'.length);
        return handleGet(request, env, user, key);
    }
    if (url.pathname.startsWith('/api/delete/') && method === 'DELETE') {
        const key = url.pathname.substring('/api/delete/'.length);
        return handleDelete(request, env, user, key);
    }

    return new Response("API Route Not Found", { status: 404 });
}

// --- /api/upload ハンドラー ---
async function handleUpload(request, env, user) {
    try {
        const { modelId, text, audioBase64, contentType } = await request.json();
        if (!modelId || !text || !audioBase64 || !contentType) {
            return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        
        const audioData = atob(audioBase64);
        const arrayBuffer = new Uint8Array(audioData.length);
        for (let i = 0; i < audioData.length; i++) {
            arrayBuffer[i] = audioData.charCodeAt(i);
        }

        const extension = contentType.split('/')[1] || 'bin';
        const r2Key = `${user.uid}/${crypto.randomUUID()}.${extension}`;
        
        await env.MY_R2_BUCKET.put(r2Key, arrayBuffer, {
            httpMetadata: { contentType },
        });

        const d1Key = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        
        const { success } = await env.MY_D1_DATABASE.prepare(
            `INSERT INTO audios (id, r2_key, user_id, model_name, text_content, created_at) VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(d1Key, r2Key, user.uid, modelId, text, createdAt).run();

        if (!success) {
            await env.MY_R2_BUCKET.delete(r2Key);
            throw new Error("Failed to write metadata to D1.");
        }

        return new Response(JSON.stringify({ success: true, key: r2Key }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    } catch (error) {
        console.error("Upload failed:", error);
        return new Response(JSON.stringify({ error: "Upload failed." }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
}

// --- /api/list ハンドラー ---
async function handleList(request, env, user) {
    try {
        const { results } = await env.MY_D1_DATABASE.prepare(
            "SELECT r2_key, model_name, text_content, created_at FROM audios WHERE user_id = ? ORDER BY created_at DESC"
        ).bind(user.uid).all();

        return new Response(JSON.stringify(results || []), {
            headers: { "Content-Type": "application/json" },
        });

    } catch (error) {
        console.error("List failed:", error);
        return new Response(JSON.stringify({ error: "Failed to list audio files." }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
}

// --- /api/get/[key] ハンドラー ---
async function handleGet(request, env, user, key) {
    try {
        const decodedKey = decodeURIComponent(key);
        
        const stmt = env.MY_D1_DATABASE.prepare("SELECT id FROM audios WHERE r2_key = ? AND user_id = ?");
        const { results } = await stmt.bind(decodedKey, user.uid).all();

        if (!results || results.length === 0) {
            return new Response("File not found or access denied.", { status: 404 });
        }
        
        const object = await env.MY_R2_BUCKET.get(decodedKey);

        if (object === null) {
            return new Response("Object Not Found in R2", { status: 404 });
        }

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);

        return new Response(object.body, { headers });

    } catch (error) {
        console.error("Get failed:", error);
        return new Response(JSON.stringify({ error: "Failed to get audio file." }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
}

// --- /api/delete/[key] ハンドラー ---
async function handleDelete(request, env, user, key) {
    try {
        const decodedKey = decodeURIComponent(key);

        const stmt = env.MY_D1_DATABASE.prepare("DELETE FROM audios WHERE r2_key = ? AND user_id = ? RETURNING id");
        const { results } = await stmt.bind(decodedKey, user.uid).all();

        if (!results || results.length === 0) {
            return new Response(JSON.stringify({ error: "File not found or access denied." }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }
        
        await env.MY_R2_BUCKET.delete(decodedKey);

        return new Response(JSON.stringify({ success: true, key: decodedKey }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    } catch (error) {
        console.error("Delete failed:", error);
        return new Response(JSON.stringify({ error: "Failed to delete audio file." }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
}