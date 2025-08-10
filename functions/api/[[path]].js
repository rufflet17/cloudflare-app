// firebase-adminをインポート
import admin from 'firebase-admin';

// --- Firebase Admin SDKの初期化 ---
// サービスアカウント情報を環境変数から読み込む
// 一度だけ初期化するため、トップレベルで実行
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

// --- 認証ミドルウェア ---
async function authenticate(request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null; // トークンがない
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    // トークンを検証
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    return decodedToken; // 検証成功、ユーザー情報を返す
  } catch (error) {
    console.error('Authentication error:', error.message);
    return null; // 検証失敗
  }
}

// --- APIハンドラー ---
export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // ルーティング
  if (path === "/get-models" && method === "GET") {
    return handleGetModels(context);
  }
  if (path === "/synthesize" && method === "POST") {
    // 音声合成はログイン不要の場合もあるため、ここでは認証をかけない
    return handleSynthesize(context);
  }
  if (path.startsWith("/api/")) {
    // /api/ 以下のルートはすべて認証を要求
    const user = await authenticate(request);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }
    // 認証済みユーザー情報をcontextに追加して次のハンドラへ
    context.user = user;
    return handleApiRoutes(context);
  }

  return next();
}

// --- /get-models ハンドラー (変更なし) ---
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
      throw new Error(`Cloudflare API error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return new Response(JSON.stringify(data.result.map(m => ({id: m.name, name: m.name.split('/').pop()}))), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in handleGetModels:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch models." }), { status: 500 });
  }
}

// --- /synthesize ハンドラー (変更なし) ---
async function handleSynthesize({ request, env }) {
  try {
    const { model_id, texts, style_id, style_strength, format } = await request.json();
    if (!model_id || !texts || !Array.isArray(texts)) {
        return new Response(JSON.stringify({ error: "Missing required parameters" }), { status: 400 });
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
    return new Response(JSON.stringify({ error: "Failed to synthesize." }), { status: 500 });
  }
}

// --- /api/* ルートの処理 ---
// 'user' を引数で受け取るのではなく、contextから受け取るように変更
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

// --- 各APIハンドラー (変更なし、ただし 'user' の由来がセキュアになった) ---
// /api/upload
async function handleUpload(request, env, user) {
    try {
        const { modelId, text, audioBase64, contentType } = await request.json();
        if (!modelId || !text || !audioBase64 || !contentType) {
            return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400 });
        }
        const audioData = atob(audioBase64);
        const arrayBuffer = new Uint8Array(audioData.length);
        for (let i = 0; i < audioData.length; i++) arrayBuffer[i] = audioData.charCodeAt(i);

        const extension = contentType.split('/')[1] || 'bin';
        const r2Key = `${user.uid}/${crypto.randomUUID()}.${extension}`; // ★本物のユーザーIDが使われる
        
        await env.MY_R2_BUCKET.put(r2Key, arrayBuffer, { httpMetadata: { contentType } });

        const d1Key = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        const { success } = await env.MY_D1_DATABASE.prepare(
            `INSERT INTO audios (id, r2_key, user_id, model_name, text_content, created_at) VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(d1Key, r2Key, user.uid, modelId, text, createdAt).run();

        if (!success) {
            await env.MY_R2_BUCKET.delete(r2Key);
            throw new Error("Failed to write metadata to D1.");
        }
        return new Response(JSON.stringify({ success: true, key: r2Key }), { status: 200 });
    } catch (error) {
        console.error("Upload failed:", error);
        return new Response(JSON.stringify({ error: "Upload failed." }), { status: 500 });
    }
}

// /api/list
async function handleList(request, env, user) {
    try {
        const { results } = await env.MY_D1_DATABASE.prepare(
            "SELECT r2_key, model_name, text_content, created_at FROM audios WHERE user_id = ? ORDER BY created_at DESC"
        ).bind(user.uid).all(); // ★本物のユーザーIDでフィルタリング
        return new Response(JSON.stringify(results || []), { headers: { "Content-Type": "application/json" } });
    } catch (error) {
        return new Response(JSON.stringify({ error: "Failed to list files." }), { status: 500 });
    }
}

// /api/get/[key]
async function handleGet(request, env, user, key) {
    try {
        const stmt = env.MY_D1_DATABASE.prepare("SELECT id FROM audios WHERE r2_key = ? AND user_id = ?");
        const { results } = await stmt.bind(key, user.uid).all(); // ★本物のユーザーIDで所有権確認

        if (!results || results.length === 0) {
            return new Response("File not found or access denied.", { status: 404 });
        }
        const object = await env.MY_R2_BUCKET.get(key);
        if (object === null) return new Response("Object Not Found in R2", { status: 404 });
        
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        return new Response(object.body, { headers });
    } catch (error) {
        return new Response(JSON.stringify({ error: "Failed to get file." }), { status: 500 });
    }
}

// /api/delete/[key]
async function handleDelete(request, env, user, key) {
    try {
        const stmt = env.MY_D1_DATABASE.prepare("DELETE FROM audios WHERE r2_key = ? AND user_id = ? RETURNING id");
        const { results } = await stmt.bind(key, user.uid).all(); // ★本物のユーザーIDで所有権確認

        if (!results || results.length === 0) {
            return new Response(JSON.stringify({ error: "File not found or access denied." }), { status: 404 });
        }
        await env.MY_R2_BUCKET.delete(key);
        return new Response(JSON.stringify({ success: true, key }), { status: 200 });
    } catch (error) {
        return new Response(JSON.stringify({ error: "Failed to delete file." }), { status: 500 });
    }
}