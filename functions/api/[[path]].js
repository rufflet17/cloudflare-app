// btoaはNode.js環境ではデフォルトで利用できないため、Cloudflare Workersのグローバルスコープで利用可能なことを前提としています。

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

  // ★修正点1: マッチしない場合は次の処理（静的アセットの配信など）へ
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

    // --- 認証を削除し、ダミーユーザー情報を設定 ---
    // セキュリティを考慮しないため、すべてのリクエストを同じ固定ユーザーとして扱う
    const user = { uid: "shared-user" };

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
        
        // ★修正点2: env.MY_BUCKET -> env.MY_R2_BUCKET
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
            // ★修正点2: env.MY_BUCKET -> env.MY_R2_BUCKET
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
        
        // ★修正点2: env.MY_BUCKET -> env.MY_R2_BUCKET
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
        
        // ★修正点2: env.MY_BUCKET -> env.MY_R2_BUCKET
        await env.MY_R2_BUCKET.delete(decodedKey);

        return new Response(JSON.stringify({ success: true, key: decodedKey }), { status: 200 });

    } catch (error) {
        console.error("Delete failed:", error);
        return new Response(JSON.stringify({ error: "Failed to delete audio file." }), { status: 500 });
    }
}