import { jwtVerify, createRemoteJWKSet } from 'jose';

// Firebaseの公開鍵をGoogleのサーバーから取得するためのJWKSetを準備
const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'));

/**
 * リクエストヘッダーからFirebase IDトークンを検証する
 */
async function verifyAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { error: new Response(JSON.stringify({error: 'Missing or invalid Authorization header'}), { status: 401, headers: {'Content-Type': 'application/json'} }) };
  }

  const token = authHeader.substring(7);
  const projectId = env.FIREBASE_PROJECT_ID;

  if (!projectId) {
      console.error("FATAL: FIREBASE_PROJECT_ID environment variable not set.");
      return { error: new Response(JSON.stringify({error: 'Server configuration error'}), { status: 500, headers: {'Content-Type': 'application/json'} }) };
  }

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    });
    return { user: { uid: payload.sub, email: payload.email } };
  } catch (err) {
    console.error('Token verification failed:', err.message);
    let status = 403;
    let message = 'Invalid or expired token.';
    if (err.code === 'ERR_JWT_EXPIRED') {
        status = 401;
        message = 'Token has expired.';
    }
    return { error: new Response(JSON.stringify({error: message}), { status, headers: {'Content-Type': 'application/json'} }) };
  }
}

// --- APIハンドラー ---
export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/get-models" && method === "GET") {
    return handleGetModels(context);
  }
  if (path === "/synthesize" && method === "POST") {
    return handleSynthesize(context);
  }
  if (path.startsWith("/api/")) {
    return handleApiRoutes(context);
  }

  return context.next();
}

// --- /api/* ルートの処理（認証を組み込む） ---
async function handleApiRoutes(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const method = request.method;

    const authResult = await verifyAuth(request, env);
    if (authResult.error) {
        return authResult.error;
    }
    const user = authResult.user;

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
        return new Response(JSON.stringify({ error: "Missing required parameters: model_id, texts (array)." }), { status: 400 });
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

// --- /api/upload ハンドラー ---
async function handleUpload(request, env, user) {
    try {
        const { modelId, text, audioBase64, contentType } = await request.json();
        if (!modelId || !text || !audioBase64 || !contentType) {
            return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400, headers: {'Content-Type': 'application/json'} });
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

        return new Response(JSON.stringify({ success: true, key: r2Key }), { status: 200, headers: {'Content-Type': 'application/json'} });

    } catch (error) {
        console.error("Upload failed:", error);
        return new Response(JSON.stringify({ error: "Upload failed." }), { status: 500, headers: {'Content-Type': 'application/json'} });
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
        return new Response(JSON.stringify({ error: "Failed to list audio files." }), { status: 500, headers: {'Content-Type': 'application/json'} });
    }
}

// --- /api/get/[key] ハンドラー ---
async function handleGet(request, env, user, key) {
    try {
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
        return new Response(JSON.stringify({ error: "Failed to get audio file." }), { status: 500, headers: {'Content-Type': 'application/json'} });
    }
}

// --- /api/delete/[key] ハンドラー ---
async function handleDelete(request, env, user, key) {
    try {
        const stmt = env.MY_D1_DATABASE.prepare("DELETE FROM audios WHERE r2_key = ? AND user_id = ? RETURNING id");
        const { results } = await stmt.bind(key, user.uid).all();

        if (!results || results.length === 0) {
            return new Response(JSON.stringify({ error: "File not found or access denied." }), { status: 404, headers: {'Content-Type': 'application/json'} });
        }
        
        await env.MY_R2_BUCKET.delete(key);

        return new Response(JSON.stringify({ success: true, key: key }), { status: 200, headers: {'Content-Type': 'application/json'} });

    } catch (error) {
        console.error("Delete failed:", error);
        return new Response(JSON.stringify({ error: "Failed to delete audio file." }), { status: 500, headers: {'Content-Type': 'application/json'} });
    }
}