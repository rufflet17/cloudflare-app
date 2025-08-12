// firebase-adminのJWT検証機能を模倣するためのヘルパー関数群
async function verifyAdminToken(token, env) {
    // 本番環境では厳格なJWT検証が必須
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

    if (path === '/api/rankings' && method === 'GET') {
        return handleGetRankings(env, url.searchParams);
    }
    if (path.startsWith('/api/users/') && path.endsWith('/posts') && method === 'GET') {
        const userId = path.split('/')[3];
        return handleListUserPosts(env, userId, url.searchParams);
    }
    if (path.startsWith('/api/posts/') && method === 'DELETE') {
        const postId = path.split('/')[3];
        return handleDeletePost(env, postId);
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
    
    return new Response(JSON.stringify({ error: "Admin API Route Not Found" }), { status: 404, headers: { 'Content-Type': 'application/json' }});
}

// --- API実装 ---

async function handleGetRankings(env, params) {
    const period = params.get('period'); // 'all', 'monthly', 'weekly', 'daily'
    const date = params.get('date'); // YYYY-MM-DD

    let whereClause = '';
    let bindings = [];

    if (period !== 'all') {
        if (!date) return new Response(JSON.stringify({ error: "Date parameter is required for periodic rankings" }), { status: 400 });
        let format;
        let value;
        switch (period) {
            case 'daily':   format = '%Y-%m-%d'; value = date; break;
            case 'weekly':  format = '%Y-%W';    value = date; break; // JS側でYYYY-WWに変換して渡す
            case 'monthly': format = '%Y-%m';    value = date.substring(0, 7); break;
            default: return new Response(JSON.stringify({ error: "Invalid period" }), { status: 400 });
        }
        whereClause = `WHERE strftime(?, a.created_at) = ?`; // "a." を追加
        bindings = [format, value];
    }

    try {
        const query = `
            SELECT 
                a.user_id, 
                COUNT(a.id) as post_count,
                COALESCE(us.is_blocked, 0) as is_blocked
             FROM audios a
             LEFT JOIN user_status us ON a.user_id = us.user_id
             ${whereClause}
             GROUP BY a.user_id
             ORDER BY post_count DESC
             LIMIT 100`; // 上位100ユーザーまで表示
        const { results } = await env.MY_D1_DATABASE.prepare(query).bind(...bindings).all();
        return new Response(JSON.stringify(results || []), { headers: { 'Content-Type': 'application/json' }});
    } catch (e) {
        console.error("Error in handleGetRankings:", e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}

async function handleListUserPosts(env, userId, params) {
    const searchText = params.get('searchText');
    const limitParam = params.get('limit');
    
    let whereConditions = ['user_id = ?'];
    let bindings = [userId];
    
    if (searchText) {
        whereConditions.push('text_content LIKE ?');
        bindings.push(`%${searchText}%`);
    }

    const whereClause = `WHERE ${whereConditions.join(' AND ')}`;
    const limitClause = limitParam === 'all' ? '' : 'LIMIT ?';
    if (limitParam !== 'all') {
        const limit = parseInt(limitParam, 10) || 100;
        bindings.push(limit);
    }

    try {
        const query = `SELECT id, r2_key, model_name, text_content, created_at FROM audios ${whereClause} ORDER BY created_at DESC ${limitClause}`;
        const { results } = await env.MY_D1_DATABASE.prepare(query).bind(...bindings).all();
        return new Response(JSON.stringify(results || []), { headers: { 'Content-Type': 'application/json' }});
    } catch (e) {
        console.error("Error in handleListUserPosts:", e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}

async function handleDeletePost(env, postId) {
    try {
        const stmt = env.MY_D1_DATABASE.prepare(`SELECT r2_key FROM audios WHERE id = ?`);
        const post = await stmt.bind(postId).first();

        if (!post) {
            return new Response(JSON.stringify({ error: "Post not found" }), { status: 404 });
        }

        await env.MY_R2_BUCKET.delete(post.r2_key);
        await env.MY_D1_DATABASE.prepare(`DELETE FROM audios WHERE id = ?`).bind(postId).run();

        return new Response(JSON.stringify({ success: true, deleted_post_id: postId }), { headers: { 'Content-Type': 'application/json' }});
    } catch (e) {
        console.error("Error in handleDeletePost:", e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}

async function handleDeleteAllPosts(env, userId) {
    // (この関数は変更なし)
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
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}

async function handleSetBlockStatus(env, userId, isBlocked) {
    // (この関数は変更なし)
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