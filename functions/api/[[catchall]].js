/**
 * functions/api/[[catchall]].js
 * 
 * Cloudflare Pages Function for TTS App Backend
 * Handles API requests for uploading, listing, getting, and deleting audio files
 * using D1 for metadata and R2 for file storage.
 */

// Helper: エラーレスポンスを生成
function errorResponse(message, status = 500) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Helper: Base64をArrayBufferに変換
function base64ToArrayBuffer(base64) {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
}

// メインリクエストハンドラ
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const pathSegments = url.pathname.split('/').filter(Boolean).slice(1);

  const R2_BUCKET = env.MY_R2_BUCKET;
  const D1_DB = env.MY_D1_DATABASE;
  if (!R2_BUCKET || !D1_DB) {
    return errorResponse("R2 or D1 bindings are not configured. Please set them in your Pages project settings.", 500);
  }

  try {
    const resource = pathSegments[0];
    const params = pathSegments.slice(1);

    if (request.method === 'POST' && resource === 'audios') {
        return await handleUpload(request, R2_BUCKET, D1_DB);
    }
    if (request.method === 'GET' && resource === 'audios' && params[0] === 'user' && params[1]) {
        const userId = decodeURIComponent(params[1]);
        return await handleListByUser(userId, url.searchParams, D1_DB);
    }
    if (request.method === 'DELETE' && resource === 'audios' && params[0]) {
        const recordId = decodeURIComponent(params[0]);
        return await handleDelete(recordId, R2_BUCKET, D1_DB);
    }
    if (request.method === 'GET' && resource === 'get' && params.length > 0) {
        const getKey = decodeURIComponent(params.join('/'));
        return await handleGet(getKey, R2_BUCKET);
    }

    // 音声合成リクエストをCloudflare AIにプロキシする
    if (request.method === 'POST' && resource === 'synthesize') {
        return await handleSynthesize(request, env);
    }

    // モデル一覧を取得する
    if (request.method === 'GET' && resource === 'get-models') {
        return await handleGetModels(env);
    }

    return new Response('API endpoint not found', { status: 404 });
    
  } catch (err) {
    console.error(`[API Error] ${err.name}: ${err.message}\n${err.stack}`);
    return errorResponse(err.message || 'An internal server error occurred.', 500);
  }
}

/**
 * アップロード処理: POST /api/audios
 */
async function handleUpload(request, R2_BUCKET, D1_DB) {
  const { userId, modelName, textContent, audioBase64, contentType } = await request.json();
  if (!userId || !modelName || !audioBase64 || !contentType) {
    return errorResponse("Required fields are missing (userId, modelName, textContent, audioBase64, contentType).", 400);
  }

  const recordId = crypto.randomUUID();
  const r2Key = `${userId}/${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  
  await D1_DB.prepare(
    'INSERT INTO audios (id, r2_key, user_id, model_name, text_content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(recordId, r2Key, userId, modelName, textContent, createdAt).run();
  
  const body = base64ToArrayBuffer(audioBase64);
  await R2_BUCKET.put(r2Key, body, { httpMetadata: { contentType } });
  
  return new Response(JSON.stringify({ success: true, id: recordId, r2Key: r2Key }), {
    status: 201, headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * ユーザー基準の一覧取得処理: GET /api/audios/user/:userId
 */
async function handleListByUser(userId, searchParams, D1_DB) {
  const textQuery = searchParams.get('text') || '';
  const modelQuery = searchParams.get('model') || '';

  let query = 'SELECT id, r2_key, model_name, text_content, created_at FROM audios WHERE user_id = ?';
  const bindings = [userId];
  
  if (textQuery) { query += ' AND text_content LIKE ?'; bindings.push(`%${textQuery}%`); }
  if (modelQuery) { query += ' AND model_name = ?'; bindings.push(modelQuery); }
  
  query += ' ORDER BY created_at DESC LIMIT 100';

  const { results } = await D1_DB.prepare(query).bind(...bindings).all();
  return new Response(JSON.stringify(results || []), { headers: { 'Content-Type': 'application/json' } });
}

/**
 * 削除処理: DELETE /api/audios/:recordId
 */
async function handleDelete(id, R2_BUCKET, D1_DB) {
    if (!id) return errorResponse('Record ID is missing.', 400);
    const record = await D1_DB.prepare('SELECT r2_key FROM audios WHERE id = ?').bind(id).first();
    if (!record) return errorResponse('Record not found.', 404);
    await R2_BUCKET.delete(record.r2_key);
    await D1_DB.prepare('DELETE FROM audios WHERE id = ?').bind(id).run();
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
}

/**
 * ファイル取得処理: GET /api/get/:r2_key*
 */
async function handleGet(key, R2_BUCKET) {
    if (!key) return errorResponse('File key is missing.', 400);
    const object = await R2_BUCKET.get(key);
    if (object === null) return new Response('Object Not Found', { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    return new Response(object.body, { headers });
}

/**
 * 音声合成リクエストのプロキシ: POST /api/synthesize
 */
async function handleSynthesize(request, env) {
    if (!env.AI) return errorResponse("AI binding not configured.", 500);
    const { model_id, texts, style_id, style_strength, format } = await request.json();
    
    const results = await Promise.all(texts.map(async text => {
        try {
            const inputs = { text, voice: model_id };
            if (style_id !== undefined && style_strength !== undefined) {
                inputs.style_id = style_id;
                inputs.style_strength = style_strength;
            }
            const response = await env.AI.run(`@cf/coqui/xtts-v2`, inputs);
            const contentType = `audio/${format}`;
            return {
                status: 'success',
                text: text,
                audio_base_64: btoa(String.fromCharCode(...new Uint8Array(response))),
                content_type: contentType
            };
        } catch (e) {
            return { status: 'error', text: text, reason: e.message };
        }
    }));

    return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
}

/**
 * モデル一覧取得: GET /api/get-models
 */
async function handleGetModels(env) {
    // ここではハードコードしていますが、将来的にはCloudflareのAPIから動的に取得することも考えられます
    const models = [
        { id: "@cf/coqui/xtts-v2", name: "Coqui XTTS v2 (多言語対応)" },
        // 他の利用可能なモデルを追加
    ];
    return new Response(JSON.stringify(models), { headers: { "Content-Type": "application/json" } });
}

// btoaのpolyfill for non-browser environments like Workers
function btoa(str) {
    return Buffer.from(str, 'binary').toString('base64');
}