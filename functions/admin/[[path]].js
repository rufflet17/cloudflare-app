// firebase-adminのJWT検証機能を模倣するためのヘルパー関数群
// Workers環境では自前で実装するか、'jose'のようなライブラリを利用します。
async function verifyAdminToken(token, env) {
    // 本番環境では、Firebase Admin SDKで発行したカスタムトークンを厳格に検証するロジックが必須です。
    // 例: joseライブラリを使って公開鍵で署名を検証するなど。
    // 今回はデモとして、トークンが存在すればOKとします。
    // 実際の運用ではこの部分を強化してください。
    return token ? { admin: true } : null;
}

// --- 管理者APIのメインハンドラー ---
export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const method = request.method;

    // --- 管理者認証 ---
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ error: "Unauthorized: Missing token" }), { status: 401, headers: { 'Content-Type': 'application/json' }});
    }
    const token = authHeader.substring(7);
    const decodedToken = await verifyAdminToken(token, env);
    if (!decodedToken || !decodedToken.admin) {
        return new Response(JSON.stringify({ error: "Unauthorized: Invalid or non-admin token" }), { status: 403, headers: { 'Content-Type': 'application/json' }});
    }

    // --- ルーティング ---
    const path = url.pathname.replace('/admin', ''); // `/admin`プレフィックスを削除してルーティング

    if (path === '/api/users' && method === 'GET') {
        return handleListUsers(env);
    }
    if (path.startsWith('/api/users/') && path.endsWith('/delete-all-posts') && method === 'POST') {
        const userId = path.split('/')[3];
        return handleDeleteAllPosts(env, userId);
    }
    if (path.startsWith('/api/users/') && path.endsWith('/block') && method === 'POST') {
        const userId = path.split('/')[3];
        return handleSetBlockStatus(env, userId, true);
    }
    if (path.startsWith('/api/users/') && path.endsWith('/unblock') && method === 'POST') {
        const userId = path.split('/')[3];
        return handleSetBlockStatus(env, userId, false);
    }
    if (path === '/api/stats/user-posts' && method === 'GET') {
        return handleUserPostStats(env, url.searchParams);
    }
    
    return new Response(JSON.stringify({ error: "Admin API Route Not Found" }), { status: 404, headers: { 'Content-Type': 'application/json' }});
}

// --- API実装 ---

async function handleListUsers(env) {
    try {
        // ユーザーごとの投稿数とブロック状態を取得するクエリ
        const { results } = await env.MY_D1_DATABASE.prepare(
            `SELECT 
                a.user_id, 
                COUNT(a.id) as post_count,
                COALESCE(us.is_blocked, 0) as is_blocked
             FROM audios a
             LEFT JOIN user_status us ON a.user_id = us.user_id
             GROUP BY a.user_id
             ORDER BY post_count DESC`
        ).all();
        return new Response(JSON.stringify(results || []), { headers: { 'Content-Type': 'application/json' }});
    } catch (e) {
        console.error("Error in handleListUsers:", e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' }});
    }
}

async function handleDeleteAllPosts(env, userId) {
    try {
        // 1. D1から対象ユーザーの全投稿のR2キーを取得
        const { results } = await env.MY_D1_DATABASE.prepare(`SELECT r2_key FROM audios WHERE user_id = ?`).bind(userId).all();
        if (!results || results.length === 0) {
            return new Response(JSON.stringify({ message: "No posts to delete." }), { status: 200, headers: { 'Content-Type': 'application/json' }});
        }
        const keysToDelete = results.map(row => row.r2_key);
        
        // 2. R2からファイルを一括削除 (1000件まで一度に削除可能)
        if (keysToDelete.length > 0) {
            await env.MY_R2_BUCKET.delete(keysToDelete);
        }
        
        // 3. D1からメタデータを削除
        await env.MY_D1_DATABASE.prepare(`DELETE FROM audios WHERE user_id = ?`).bind(userId).run();

        return new Response(JSON.stringify({ success: true, deleted_count: keysToDelete.length }), { headers: { 'Content-Type': 'application/json' }});
    } catch (e) {
        console.error("Error in handleDeleteAllPosts:", e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' }});
    }
}

async function handleSetBlockStatus(env, userId, isBlocked) {
     try {
        // `user_status`テーブルにUPSERT (存在しなければINSERT, 存在すればUPDATE)
        await env.MY_D1_DATABASE.prepare(
            `INSERT INTO user_status (user_id, is_blocked, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(user_id) DO UPDATE SET is_blocked = excluded.is_blocked, updated_at = CURRENT_TIMESTAMP`
        ).bind(userId, isBlocked ? 1 : 0).run(); // D1のBOOLEANは 1 or 0

        return new Response(JSON.stringify({ success: true, user_id: userId, is_blocked: isBlocked }), { headers: { 'Content-Type': 'application/json' }});
     } catch (e) {
        console.error("Error in handleSetBlockStatus:", e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' }});
    }
}

async function handleUserPostStats(env, params) {
    const userId = params.get('userId');
    const period = params.get('period'); // 'daily', 'weekly', 'monthly'
    if (!userId || !period) {
        return new Response(JSON.stringify({ error: "userId and period are required" }), { status: 400, headers: { 'Content-Type': 'application/json' }});
    }

    let dateFormat;
    switch (period) {
        case 'daily':   dateFormat = '%Y-%m-%d'; break;
        case 'weekly':  dateFormat = '%Y-%W'; break;
        case 'monthly': dateFormat = '%Y-%m'; break;
        default: return new Response(JSON.stringify({ error: "Invalid period" }), { status: 400, headers: { 'Content-Type': 'application/json' }});
    }

    try {
        const query = `
            SELECT strftime(?, created_at) as date_period, COUNT(*) as post_count
            FROM audios
            WHERE user_id = ?
            GROUP BY date_period
            ORDER BY date_period DESC
            LIMIT 30`; // 直近30期間分を取得
        const { results } = await env.MY_D1_DATABASE.prepare(query).bind(dateFormat, userId).all();
        return new Response(JSON.stringify(results || []), { headers: { 'Content-Type': 'application/json' }});
    } catch (e) {
        console.error("Error in handleUserPostStats:", e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' }});
    }
}