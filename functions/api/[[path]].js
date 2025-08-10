// ★★★ 変更点 ★★★
// firebase-admin パッケージをインポート
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

// --- Firebase Admin SDKの初期化 ---
// 重複初期化を避けるための処理
function initializeFirebaseAdmin(env) {
  // getApps()で既に初期化されているかチェック
  if (getApps().length === 0) {
    try {
      // 環境変数からサービスアカウント情報をJSONとしてパース
      const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
      initializeApp({
        credential: cert(serviceAccount),
      });
      console.log("Firebase Admin SDK initialized successfully.");
    } catch (error) {
      console.error("Error initializing Firebase Admin SDK:", error);
      // エラーが発生しても処理は続行されるが、後のgetAuth()で失敗する
    }
  }
}

// ★★★ 変更点 ★★★
// --- 認証ミドルウェア ---
// リクエストヘッダーからIDトークンを検証する
async function verifyToken(request, env) {
  // 毎回初期化チェックを行うことで、複数のリクエストにまたがってSDKが利用できるようにする
  initializeFirebaseAdmin(env);
  
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    // 認証ヘッダーがない、または形式が不正
    return { error: "Authorization header is missing or invalid.", status: 401, user: null };
  }
  
  const idToken = authHeader.split("Bearer ")[1];
  try {
    // IDトークンを検証し、デコードされたユーザー情報を取得
    const decodedToken = await getAuth().verifyIdToken(idToken);
    return { user: decodedToken, error: null, status: 200 };
  } catch (error) {
    console.error("Token verification failed:", error.message);
    let errorMessage = "Invalid or expired token.";
    // トークンが期限切れの場合、より分かりやすいメッセージを返す
    if (error.code === 'auth/id-token-expired') {
        errorMessage = 'Token has expired. Please log in again.';
    }
    return { error: errorMessage, status: 403, user: null };
  }
}


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
  if (path.startsWith("/api/")) {
    return handleApiRoutes(context);
  }

  // マッチしない場合は次の処理へ
  return new Response("Not Found", { status: 404 });
}

// (handleGetModels と handleSynthesize は変更なしのため省略)
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
        return new Response(JSON.stringify({ error: "Missing required parameters: model_id, texts (array)." }), { status: 400 });
    }
    
    // Cloudflare AI Gateway/Workers AIは現在一度に一つのテキストしか処理できないため、ループ処理
    const results = [];
    for (const text of texts) {
        try {
            const inputs = { text };
            if (style_id !== undefined && style_strength !== undefined) {
                inputs.speaker = style_id.toString();
                inputs.style_strength = style_strength;
            }

            const response = await env.AI.run(model_id, inputs);

            // Base64エンコード
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

    // ★★★ 変更点 ★★★
    // --- 認証チェック ---
    // ダミーユーザーの代わりにverifyTokenを呼び出す
    const authResult = await verifyToken(request, env);
    if (authResult.error) {
        // 認証に失敗した場合、エラーレスポンスを返し、処理を中断する
        return new Response(JSON.stringify({ error: authResult.error }), { 
            status: authResult.status, 
            headers: { "Content-Type": "application/json" } 
        });
    }
    // 認証に成功した場合、検証済みのユーザー情報を取得
    const { user } = authResult;

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

// (handleUpload, handleList, handleGet, handleDelete は変更なしのため省略)
// --- /api/upload ハンドラー ---
async function handleUpload(request, env, user) {
    try {
        const { modelId, text, audioBase64, contentType } = await request.json();
        if (!modelId || !text || !audioBase64 || !contentType) {
            return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400 });
        }
        
        // Base64デコード
        const audioData = atob(audioBase64);
        const arrayBuffer = new Uint8Array(audioData.length);
        for (let i = 0; i < audioData.length; i++) {
            arrayBuffer[i] = audioData.charCodeAt(i);
        }

        const extension = contentType.split('/')[1] || 'bin';
        const r2Key = `${user.uid}/${crypto.randomUUID()}.${extension}`;
        
        // R2にアップロード
        await env.MY_R2_BUCKET.put(r2Key, arrayBuffer, {
            httpMetadata: { contentType },
        });

        // D1にメタデータを保存
        const d1Key = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        
        const { success } = await env.MY_D1_DATABASE.prepare(
            `INSERT INTO audios (id, r2_key, user_id, model_name, text_content, created_at) VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(d1Key, r2Key, user.uid, modelId, text, createdAt).run();

        if (!success) {
            // D1への書き込みが失敗したら、アップロードしたR2オブジェクトを削除
            await env.MY_R2_BUCKET.delete(r2Key);
            throw new Error("Failed to write metadata to D1.");
        }

        return new Response(JSON.stringify({ success: true, key: r2Key }), { status: 200 });

    } catch (error) {
        console.error("Upload failed:", error);
        return new Response(JSON.stringify({ error: "Upload failed." }), { status: 500 });
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
        return new Response(JSON.stringify({ error: "Failed to list audio files." }), { status: 500 });
    }
}

// --- /api/get/[key] ハンドラー ---
async function handleGet(request, env, user, key) {
    try {
        const decodedKey = decodeURIComponent(key);
        
        // D1でキーの存在と所有権を確認
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
        return new Response(JSON.stringify({ error: "Failed to get audio file." }), { status: 500 });
    }
}

// --- /api/delete/[key] ハンドラー ---
async function handleDelete(request, env, user, key) {
    try {
        const decodedKey = decodeURIComponent(key);

        // D1でキーの存在と所有権を確認してから削除
        const stmt = env.MY_D1_DATABASE.prepare("DELETE FROM audios WHERE r2_key = ? AND user_id = ? RETURNING id");
        const { results } = await stmt.bind(decodedKey, user.uid).all();

        if (!results || results.length === 0) {
            // 削除対象が見つからない、または所有権がない
            return new Response(JSON.stringify({ error: "File not found or access denied." }), { status: 404 });
        }
        
        // D1から正常に削除できたら、R2からも削除
        await env.MY_R2_BUCKET.delete(decodedKey);

        return new Response(JSON.stringify({ success: true, key: decodedKey }), { status: 200 });

    } catch (error) {
        console.error("Delete failed:", error);
        return new Response(JSON.stringify({ error: "Failed to delete audio file." }), { status: 500 });
    }
}