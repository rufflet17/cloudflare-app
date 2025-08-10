// =================================================================
// 依存ライブラリのインポート
// =================================================================
import { createRemoteJWKSet, jwtVerify } from 'jose';

// =================================================================
// 認証ミドルウェア (jose を使用)
// =================================================================

// Googleの公開鍵を取得するためのURL
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

// 公開鍵セットを取得・キャッシュするインスタンスを作成。
// このインスタンスはリクエスト間で再利用され、パフォーマンスが向上します。
const JWKS = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));

/**
 * リクエストヘッダーのAuthorizationトークンを検証する
 * @param {Request} request - Cloudflareからのリクエストオブジェクト
 * @param {object} env - 環境変数が格納されたオブジェクト
 * @returns {Promise<object|null>} 検証成功時はデコードされたトークンペイロード、失敗時はnull
 */
async function authenticate(request, env) {
  // 1. ヘッダーから "Bearer <token>" 形式でトークンを取得
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null; // トークンが存在しない
  }
  const idToken = authHeader.split('Bearer ')[1];

  // 2. FirebaseプロジェクトIDを環境変数から取得
  const firebaseProjectId = env.FIREBASE_PROJECT_ID;
  if (!firebaseProjectId) {
    console.error("CRITICAL: FIREBASE_PROJECT_ID environment variable is not set.");
    // サーバー設定エラーなので例外を投げる
    throw new Error('Server configuration error: FIREBASE_PROJECT_ID is missing.');
  }

  try {
    // 3. joseを使ってトークンを検証
    const { payload } = await jwtVerify(idToken, JWKS, {
      issuer: `https://securetoken.google.com/${firebaseProjectId}`,
      audience: firebaseProjectId,
    });
    
    // 検証成功！ペイロードを返す。
    // 後続の処理で `user.uid` を参照するため、互換性プロパティを追加。
    payload.uid = payload.sub; 
    return payload;
  } catch (error) {
    // トークンが無効な場合 (期限切れ、署名不正など)
    console.error('Authentication error:', error.code, error.message);
    return null; // 検証失敗
  }
}

// =================================================================
// メインのAPIハンドラー (onRequest)
// =================================================================

export async function onRequest(context) {
  const { request, env, next } = context;

  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  try {
    // --- ルーティング ---

    // Public Route (認証不要)
    if (path === "/get-models" && method === "GET") {
      return handleGetModels(context);
    }
    // Public Route (認証不要)
    if (path === "/synthesize" && method === "POST") {
      return handleSynthesize(context);
    }

    // Secure Routes (認証必須)
    if (path.startsWith("/api/")) {
      const user = await authenticate(request, env);
      if (!user) {
        return new Response(JSON.stringify({ error: 'Unauthorized. Invalid or missing token.' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // 認証済みユーザー情報をcontextに追加して、後続のハンドラで使えるようにする
      context.user = user;
      return handleApiRoutes(context);
    }

  } catch (e) {
    // authenticate関数内で投げられた設定エラーなどをキャッチ
    console.error('Request processing failed:', e.message);
    return new Response('Internal Server Error.', { status: 500 });
  }

  // どのルートにもマッチしない場合は、静的アセットを探しに行く
  return next();
}

// =================================================================
// 各種APIルートハンドラー
// =================================================================

// --- Public Handlers ---

async function handleGetModels({ env }) {
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/ai/models/search?task=text-to-speech`,
      { headers: { Authorization: `Bearer ${env.API_TOKEN}` } }
    );
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Cloudflare API error: ${response.status} ${errorText}`);
    }
    const data = await response.json();
    return new Response(JSON.stringify(data.result.map(m => ({ id: m.name, name: m.name.split('/').pop() }))), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in handleGetModels:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch models." }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleSynthesize({ request, env }) {
  try {
    const { model_id, texts, style_id, style_strength, format } = await request.json();
    if (!model_id || !texts || !Array.isArray(texts)) {
      return new Response(JSON.stringify({ error: "Missing required parameters" }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const results = [];
    for (const text of texts) {
      try {
        const inputs = { text };
        if (style_id !== undefined) inputs.speaker = style_id.toString();
        if (style_strength !== undefined) inputs.style_strength = style_strength;
        const response = await env.AI.run(model_id, inputs);
        const arrayBuffer = await new Response(response).arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
        results.push({ status: 'success', text, audio_base_64: base64, content_type: `audio/${format}` });
      } catch (e) {
        results.push({ status: 'error', text, reason: e.message });
      }
    }
    return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error("Error in handleSynthesize:", error);
    return new Response(JSON.stringify({ error: "Failed to synthesize." }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

// --- Secure Handlers ---

async function handleApiRoutes({ request, env, user }) {
  const url = new URL(request.url);
  const method = request.method;
  
  if (url.pathname === '/api/upload' && method === 'POST') {
    return handleUpload(request, env, user);
  }
  if (url.pathname === '/api/list' && method === 'GET') {
    return handleList(request, env, user);
  }
  if (url.pathname.startsWith('/api/get/') && method === 'GET') {
    const key = decodeURIComponent(url.pathname.substring('/api/get/'.length));
    return handleGet(request, env, user, key);
  }
  if (url.pathname.startsWith('/api/delete/') && method === 'DELETE') {
    const key = decodeURIComponent(url.pathname.substring('/api/delete/'.length));
    return handleDelete(request, env, user, key);
  }
  return new Response("API Route Not Found", { status: 404 });
}

async function handleUpload(request, env, user) {
  try {
    const { modelId, text, audioBase64, contentType } = await request.json();
    if (!modelId || !text || !audioBase64 || !contentType) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    // Base64デコード
    const binaryStr = atob(audioBase64);
    const len = binaryStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
    }
    
    const extension = contentType.split('/')[1] || 'bin';
    const r2Key = `${user.uid}/${crypto.randomUUID()}.${extension}`;
    
    await env.MY_R2_BUCKET.put(r2Key, bytes, { httpMetadata: { contentType } });
    
    const d1Key = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    
    const { success } = await env.MY_D1_DATABASE.prepare(
      `INSERT INTO audios (id, r2_key, user_id, model_name, text_content, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(d1Key, r2Key, user.uid, modelId, text, createdAt).run();
    
    if (!success) {
      await env.MY_R2_BUCKET.delete(r2Key); // ロールバック
      throw new Error("Failed to write metadata to D1.");
    }
    return new Response(JSON.stringify({ success: true, key: r2Key }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error("Upload failed:", error);
    return new Response(JSON.stringify({ error: "Upload failed." }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleList(request, env, user) {
  try {
    const { results } = await env.MY_D1_DATABASE.prepare(
      "SELECT r2_key, model_name, text_content, created_at FROM audios WHERE user_id = ? ORDER BY created_at DESC"
    ).bind(user.uid).all();
    return new Response(JSON.stringify(results || []), { headers: { "Content-Type": "application/json" } });
  } catch (error) {
    console.error("List failed:", error);
    return new Response(JSON.stringify({ error: "Failed to list files." }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleGet(request, env, user, key) {
  try {
    // ファイルが本人のものかD1で確認
    const stmt = env.MY_D1_DATABASE.prepare("SELECT id FROM audios WHERE r2_key = ? AND user_id = ?");
    const { results } = await stmt.bind(key, user.uid).all();
    if (!results || results.length === 0) {
      return new Response("File not found or access denied.", { status: 404 });
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
    return new Response(JSON.stringify({ error: "Failed to get file." }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleDelete(request, env, user, key) {
  try {
    // RETURNING句で削除対象が存在したか確認
    const stmt = env.MY_D1_DATABASE.prepare("DELETE FROM audios WHERE r2_key = ? AND user_id = ? RETURNING id");
    const { results } = await stmt.bind(key, user.uid).all();
    
    if (!results || results.length === 0) {
      return new Response(JSON.stringify({ error: "File not found or access denied." }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    
    await env.MY_R2_BUCKET.delete(key);
    return new Response(JSON.stringify({ success: true, key }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error("Delete failed:", error);
    return new Response(JSON.stringify({ error: "Failed to delete file." }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}