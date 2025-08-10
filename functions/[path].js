// functions/[[path]].js

// このファイルの上部は元のままでOK
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

function initializeFirebaseAdmin(env) {
    // ... (元のコード)
}
async function verifyToken(request, env) {
    // ... (元のコード)
}
async function handleGetModels({ env }) {
    // ... (元のコード)
}
async function handleSynthesize({ request, env }) {
    // ... (元のコード)
}
// ここまで元のまま


// ★★★★★ ここから下がデバッグ用の変更箇所 ★★★★★

// --- グローバルなバージョン情報 ---
const DEPLOYMENT_VERSION = "v3.0-debug-logging"; // コミットごとにバージョンを変える

// --- /api/* ルートの処理 ---
async function handleApiRoutes(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const method = request.method;

    console.log(`[${DEPLOYMENT_VERSION}] handleApiRoutes called for: ${url.pathname}`);
    
    // 認証チェックを一旦スキップして、まずルーティングが正しいか確認
    // const authResult = await verifyToken(request, env);
    // ...

    // --- /api/upload ---
    if (url.pathname === '/api/upload' && method === 'POST') {
        console.log(`[${DEPLOYMENT_VERSION}] Routing to handleUpload.`);
        return handleUpload(request, env, {}); // userをダミーで渡す
    }
    // ... 他のルートも同様に
    if (url.pathname === '/api/list' && method === 'GET') {
        return new Response(JSON.stringify({ message: "List endpoint reached", version: DEPLOYMENT_VERSION }));
    }

    console.log(`[${DEPLOYMENT_VERSION}] No API route matched.`);
    return new Response(JSON.stringify({ error: "API Route Not Found", version: DEPLOYMENT_VERSION }), { status: 404 });
}

// --- /api/upload ハンドラー ---
async function handleUpload(request, env, user) {
    console.log(`[${DEPLOYMENT_VERSION}] handleUpload function STARTED.`);
    try {
        const body = await request.json();
        console.log(`[${DEPLOYMENT_VERSION}] Request body received:`, JSON.stringify(body));

        const { modelId, text, audioBase64, contentType } = body;

        // ★★★ エラーメッセージを意図的に変更 ★★★
        if (!modelId || !text || !audioBase64 || !contentType) {
            const errorMessage = "NEW-ERROR: modelId, text, audioBase64, contentType are required.";
            console.log(`[${DEPLOYMENT_VERSION}] Validation failed: ${errorMessage}`);
            return new Response(JSON.stringify({ error: errorMessage, version: DEPLOYMENT_VERSION }), { status: 400 });
        }
        
        console.log(`[${DEPLOYMENT_VERSION}] Validation passed. Proceeding with upload.`);
        // ... (実際のアップロード処理は一旦コメントアウトしても良い)

        return new Response(JSON.stringify({ success: true, message: "Upload endpoint reached successfully!", version: DEPLOYMENT_VERSION }), { status: 200 });

    } catch (error) {
        console.error(`[${DEPLOYMENT_VERSION}] Upload failed with error:`, error);
        return new Response(JSON.stringify({ error: "Upload failed inside catch block.", details: error.message, version: DEPLOYMENT_VERSION }), { status: 500 });
    }
}

// ... 他のハンドラー (handleList, handleGet, handleDelete) は元のままでも良い ...

// --- onRequestハンドラー（トップレベル） ---
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // すべてのリクエストの最初にログを出す
  console.log(`[${DEPLOYMENT_VERSION}] Request received for path: ${path}`);
  
  if (path.startsWith("/api/")) {
    return handleApiRoutes(context);
  }
  if (path === "/get-models") {
    return handleGetModels(context);
  }
  if (path === "/synthesize") {
    return handleSynthesize(context);
  }

  // 静的アセットの場合はPagesが処理するので、ここでは何もしない
  // Pages Functionsはマッチしない場合、自動で次の処理（静的アセットの提供）に進む
  // return new Response("Not Found", { status: 404 }); // ← これは削除
}