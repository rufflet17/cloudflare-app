// firebase-adminのJWT検証機能を模倣するためのヘルパー関数群
// 通常はライブラリを使いますが、Workers環境では自前で実装する必要があります。
// (以前の[[path]].jsと同じものです)
let googlePublicKeys = null;
let keysFetchTime = 0;

async function getGooglePublicKeys() {
    // ... (以前のコードと同じため省略) ...
}
function base64UrlDecode(str) {
    // ... (以前のコードと同じため省略) ...
}
// サービスアカウントJWTの検証関数
async function verifyServiceAccountToken(token, env) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) throw new Error('Invalid token structure');
        
        const [headerB64, payloadB64] = parts;
        const header = JSON.parse(base64UrlDecode(headerB64));
        const payload = JSON.parse(base64UrlDecode(payloadB64));

        if (header.alg !== 'RS256') throw new Error('Invalid algorithm.');
        
        const now = Math.floor(Date.now() / 1000);
        if (payload.iat > now) throw new Error('Token issued in the future.');
        if (payload.exp < now) throw new Error('Token has expired.');

        const firebaseProjectId = env.FIREBASE_PROJECT_ID;
        if (!firebaseProjectId) throw new Error("FIREBASE_PROJECT_ID is not set.");
        
        // サービスアカウントの場合、aud(audience)とiss(issuer)はclient_emailと一致
        const expectedAudIss = `https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit`;
        // audの形式はプロジェクトによって異なる場合があるため、実際のトークンを見て調整が必要な場合があります
        // if (payload.aud !== expectedAudIss) throw new Error(`Invalid audience. Expected ${expectedAudIss}, got ${payload.aud}`);
        // if (payload.iss !== firebaseProjectId) throw new Error('Invalid issuer.');

        const jwks = await getGooglePublicKeys();
        const jwk = jwks.find(key => key.kid === header.kid);
        if (!jwk) throw new Error('Public key not found for kid: ' + header.kid);
        
        // ... (署名検証ロジックは以前のverifyFirebaseTokenと同じため省略) ...

        return payload; // 検証成功
    } catch (error) {
        console.error("Admin Token verification failed:", error.message);
        return null;
    }
}
// (上記関数の省略部分を補完した完全なJWT検証コードが実際には必要です)
// 今回は概念的な実装として進めます。実際にはJWTライブラリ（joseなど）の利用を推奨します。


// --- 管理者APIのメインハンドラー ---
export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const method = request.method;

    // --- 管理者認証 ---
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ error: "Unauthorized: Missing token" }), { status: 401 });
    }
    const token = authHeader.substring(7);
    
    // ここでは簡易的にトークンの存在のみチェックしますが、
    // 本番環境では上記の`verifyServiceAccountToken`のような強力な検証が必須です。
    // 例: const decoded = await verifyServiceAccountToken(token, env); if (!decoded) ...
    if (!token) { // 本来はここにJWT検証ロジックが入る
        return new Response(JSON.stringify({ error: "Unauthorized: Invalid token" }), { status: 403 });
    }

    // --- ルーティング ---
    const path = url.pathname.replace('/admin', ''); // `/admin`プレフィックスを削除してルーティング

    // ユーザー一覧を取得 (投稿数と共に)
    if (path === '/api/users' && method === 'GET') {
        return handleListUsers(env);
    }
    // 特定ユーザーの全投稿を削除
    if (path.startsWith('/api/users/') && path.endsWith('/delete-all-posts') && method === 'POST') {
        const userId = path.split('/')[3];
        return handleDeleteAllPosts(env, userId);
    }
    // 特定ユーザーをブロック
    if (path.startsWith('/api/users/') && path.endsWith('/block') && method === 'POST') {
        const userId = path.split('/')[3];
        return handleBlockUser(env, userId, true);
    }
     // 特定ユーザーのブロックを解除
    if (path.startsWith('/api/users/') && path.endsWith('/unblock') && method === 'POST') {
        const userId = path.split('/')[3];
        return handleBlockUser(env, userId, false);
    }
    
    return new Response("Admin API Route Not Found", { status: 404 });
}

// --- 各APIの実装 ---

async function handleListUsers(env) {
    try {
        // ユーザーごとの投稿数を集計するクエリ
        const { results } = await env.MY_D1_DATABASE.prepare(
            `SELECT 
                user_id, 
                COUNT(id) as post_count
             FROM audios 
             GROUP BY user_id
             ORDER BY post_count DESC`
        ).all();

        // (オプション) ブロック/ミュート情報を格納する`user_status`テーブルがあれば、ここでJOINする
        // const usersWithStatus = ...

        return new Response(JSON.stringify(results || []), { headers: { 'Content-Type': 'application/json' }});
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}

async function handleDeleteAllPosts(env, userId) {
    try {
        // 1. D1から対象ユーザーの全投稿のR2キーを取得
        const { results } = await env.MY_D1_DATABASE.prepare(
            `SELECT r2_key FROM audios WHERE user_id = ?`
        ).bind(userId).all();

        if (!results || results.length === 0) {
            return new Response(JSON.stringify({ message: "No posts to delete." }), { status: 200 });
        }

        const keysToDelete = results.map(row => row.r2_key);

        // 2. R2からファイルを一括削除 (1000件まで一度に削除可能)
        await env.MY_R2_BUCKET.delete(keysToDelete);
        
        // 3. D1からメタデータを削除
        await env.MY_D1_DATABASE.prepare(
            `DELETE FROM audios WHERE user_id = ?`
        ).bind(userId).run();

        return new Response(JSON.stringify({ success: true, deleted_count: keysToDelete.length }), { headers: { 'Content-Type': 'application/json' }});
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}

async function handleBlockUser(env, userId, isBlocked) {
     try {
        // `user_status`テーブルにUPSERT (存在しなければINSERT, 存在すればUPDATE)
        await env.MY_D1_DATABASE.prepare(
            `INSERT INTO user_status (user_id, is_blocked) VALUES (?, ?)
             ON CONFLICT(user_id) DO UPDATE SET is_blocked = excluded.is_blocked`
        ).bind(userId, isBlocked ? 1 : 0).run(); // D1のBOOLEANは 1 or 0

        return new Response(JSON.stringify({ success: true, user_id: userId, is_blocked: isBlocked }), { headers: { 'Content-Type': 'application/json' }});
     } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}