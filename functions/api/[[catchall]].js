// エラーレスポンスを生成するヘルパー関数
function errorResponse(message, status = 500) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Base64文字列をArrayBufferに変換するヘルパー関数
function base64ToArrayBuffer(base64) {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
}

// 各リクエストを処理するメインハンドラ
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const pathSegments = url.pathname.split('/').filter(Boolean);

  // ダッシュボードで設定したR2バインディングの変数名
  const R2_BUCKET = env.MY_R2_BUCKET; 
  if (!R2_BUCKET) {
    return errorResponse("R2 bucket binding 'MY_R2_BUCKET' not found. Please configure it in your Pages project settings.", 500);
  }
  
  try {
    const action = pathSegments[1];
    
    switch (`${request.method}:${action}`) {
      case 'POST:upload':
        return await handleUpload(request, R2_BUCKET);
      
      case 'GET:list':
        return await handleList(R2_BUCKET);

      case 'GET:get':
        const getKey = decodeURIComponent(pathSegments.slice(2).join('/'));
        return await handleGet(getKey, R2_BUCKET);

      case 'DELETE:delete':
        const deleteKey = decodeURIComponent(pathSegments.slice(2).join('/'));
        return await handleDelete(deleteKey, R2_BUCKET);

      default:
        return new Response('Not Found', { status: 404 });
    }
  } catch (err) {
    console.error(`[R2 Function Error] ${err.stack}`);
    return errorResponse(err.message || 'An internal server error occurred.', 500);
  }
}

// アップロード処理
async function handleUpload(request, R2_BUCKET) {
  const { fileName, audioBase64, contentType } = await request.json();
  if (!fileName || !audioBase64 || !contentType) {
    return errorResponse("fileName, audioBase64, and contentType are required.", 400);
  }
  
  const body = base64ToArrayBuffer(audioBase64);
  
  await R2_BUCKET.put(fileName, body, {
    httpMetadata: { contentType },
  });
  
  return new Response(JSON.stringify({ success: true, key: fileName }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// 一覧取得処理
async function handleList(R2_BUCKET) {
  const listed = await R2_BUCKET.list();
  const files = listed.objects.map(obj => ({
    key: obj.key,
    size: obj.size,
    lastModified: obj.uploaded,
  }));
  
  // TODO: `listed.truncated`がtrueの場合のページネーション処理（必要であれば）

  return new Response(JSON.stringify(files), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ファイル取得処理
async function handleGet(key, R2_BUCKET) {
    if (!key) return errorResponse('File key is missing.', 400);

    const object = await R2_BUCKET.get(key);

    if (object === null) {
      return new Response('Object Not Found', { status: 404 });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers); // Content-Typeなどを自動で設定
    headers.set('etag', object.httpEtag);
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');

    return new Response(object.body, { headers });
}

// 削除処理
async function handleDelete(key, R2_BUCKET) {
    if (!key) return errorResponse('File key is missing.', 400);
    
    await R2_BUCKET.delete(key);
    
    return new Response(JSON.stringify({ success: true, key: key }), {
      headers: { 'Content-Type': 'application/json' },
    });
}