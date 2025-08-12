// firebase-adminのJWT検証機能を模倣するためのヘルパー関数群
async function verifyAdminToken(token, env) {
    // 本番環境では、Firebase Admin SDKで発行したカスタムトークンを厳格に検証するロジックが必須です。
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
    const path = url.pathname.replace('/admin', '');

    if (path === '/api/users' && method === 'GET') {
        return handleListUsers(env);
    }
    if (path.startsWith('/api/users/') && path.endsWith('/posts') && method === 'GET') {
        const userId = path.split('/')[3];
        return handleListUserPosts(env, userId);
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

async function handleListUserPosts(env, userId) {
    try {
        const { results } = await env.MY_D1_DATABASE.prepare(
            `SELECT id, r2_key, model_name, text_content, created_at FROM audios WHERE user_id = ? ORDER BY created_at DESC LIMIT 100` // 直近100件まで
        ).bind(userId).all();
        return new Response(JSON.stringify(results || []), { headers: { 'Content-Type': 'application/json' }});
    } catch (e) {
        console.error("Error in handleListUserPosts:", e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' }});
    }
}

async function handleDeleteAllPosts(env, userId) {
    try {
        const { results } = await env.MY_D1_DATABASE.prepare(`SELECT r2_key FROM audios WHERE user_id = ?`).bind(userId).all();
        if (!results || results.length === 0) {
            return new Response(JSON.stringify({ message: "No posts to delete." }), { status: 200, headers: { 'Content-Type': 'application/json' }});
        }
        const keysToDelete = results.map(row => row.r2_key);
        if (keysToDelete.length > 0) await env.MY_R2_BUCKET.delete(keysToDelete);
        await env.MY_D1_DATABASE.prepare(`DELETE FROM audios WHERE user_id = ?`).bind(userId).run();
        return new Response(JSON.stringify({ success: true, deleted_count: keysToDelete.length }), { headers: { 'Content-Type': 'application/json' }});
    } catch (e) {
        console.error("Error in handleDeleteAllPosts:", e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' }});
    }
}

async function handleSetBlockStatus(env, userId, isBlocked) {
     try {
        await env.MY_D1_DATABASE.prepare(
            `INSERT INTO user_status (user_id, is_blocked, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(user_id) DO UPDATE SET is_blocked = excluded.is_blocked, updated_at = CURRENT_TIMESTAMP`
        ).bind(userId, isBlocked ? 1 : 0).run();
        return new Response(JSON.stringify({ success: true, user_id: userId, is_blocked: isBlocked }), { headers: { 'Content-Type': 'application/json' }});
     } catch (e) {
        console.error("Error in handleSetBlockStatus:", e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' }});
    }
}

async function handleUserPostStats(env, params) {
    const userId = params.get('userId');
    const period = params.get('period'); // 'daily', 'weekly', 'monthly'
    const date = params.get('date'); // YYYY-MM-DD
    if (!userId || !period) {
        return new Response(JSON.stringify({ error: "userId and period are required" }), { status: 400, headers: { 'Content-Type': 'application/json' }});
    }

    let query, bindings;

    if (date) { // 日付指定の場合
        let format, value;
        switch (period) {
            case 'daily':   format = '%Y-%m-%d'; value = date; break;
            case 'weekly':  format = '%Y-%W'; value = date; break; // JS側でYYYY-WWに変換して渡す想定
            case 'monthly': format = '%Y-%m'; value = date.substring(0, 7); break;
            default: return new Response(JSON.stringify({ error: "Invalid period" }), { status: 400 });
        }
        query = `SELECT COUNT(*) as post_count FROM audios WHERE user_id = ? AND strftime(?, created_at) = ?`;
        bindings = [userId, format, value];
    } else { // 期間のサマリーを取得する場合
        let dateFormat;
        switch (period) {
            case 'daily':   dateFormat = '%Y-%m-%d'; break;
            case 'weekly':  dateFormat = '%Y-%W'; break;
            case 'monthly': dateFormat = '%Y-%m'; break;
            default: return new Response(JSON.stringify({ error: "Invalid period" }), { status: 400 });
        }
        query = `
            SELECT strftime(?, created_at) as date_period, COUNT(*) as post_count
            FROM audios WHERE user_id = ? GROUP BY date_period ORDER BY date_period DESC LIMIT 30`;
        bindings = [dateFormat, userId];
    }

    try {
        const { results } = await env.MY_D1_DATABASE.prepare(query).bind(...bindings).all();
        return new Response(JSON.stringify(results || []), { headers: { 'Content-Type': 'application/json' }});
    } catch (e) {
        console.error("Error in handleUserPostStats:", e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' }});
    }
}