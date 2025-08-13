// backend/index.js

// firebase-adminのJWT検証機能を模倣するためのヘルパー関数群
async function verifyAdminToken(token, env) {
    // 本番環境では、Firebase Admin SDKで発行したカスタムトークンを厳格に検証するロ-ジックが必須です。
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

    // ★★★ 新しいAPIエンドポイントのルーティングを追加 ★★★
    if (path === '/api/posts/all' && method === 'GET') {
        return handleGetAllPosts(env, url.searchParams);
    }

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

// ★★★ 全投稿をページネーションで取得するための新しいハンドラ ★★★
async function handleGetAllPosts(env, params) {
    const limit = parseInt(params.get('limit'), 10) || 1000;
    const cursor = params.get('cursor'); // 最後に取得したデータの created_at

    let whereClause = '';
    let bindings = [];

    if (cursor) {
        whereClause = 'WHERE created_at < ?';
        bindings.push(cursor);
    }

    try {
        const query = `
            SELECT id, r2_key, user_id, model_name, text_content, created_at FROM audios 
            ${whereClause} 
            ORDER BY created_at DESC 
            LIMIT ?`;
        
        // 次ページがあるか判定するために limit + 1 件取得
        const { results } = await env.MY_D1_DATABASE.prepare(query).bind(...bindings, limit + 1).all();
        
        const has_more = results.length > limit;
        const posts = results.slice(0, limit); // 返すデータは limit 件に絞る

        return new Response(JSON.stringify({ posts, has_more }), { 
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        console.error("Error in handleGetAllPosts:", e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' }});
    }
}


// --- 既存のAPI実装 (変更なし) ---

async function handleGetRankings(env, params) {
    const period = params.get('period');
    const date = params.get('date');
    let whereClause = '';
    let bindings = [];
    if (period !== 'all') {
        if (!date) return new Response(JSON.stringify({ error: "Date parameter is required for periodic rankings" }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        switch (period) {
            case 'daily': {
                whereClause = `WHERE date(a.created_at) = ?`;
                bindings.push(date);
                break;
            }
            case 'weekly': {
                const endDate = new Date(date + 'T23:59:59.999Z');
                const startDate = new Date(endDate);
                startDate.setDate(startDate.getDate() - 6);
                startDate.setUTCHours(0, 0, 0, 0);
                whereClause = `WHERE a.created_at BETWEEN ? AND ?`;
                bindings.push(startDate.toISOString(), endDate.toISOString());
                break;
            }
            case 'monthly': {
                whereClause = `WHERE strftime('%Y-%m', a.created_at) = ?`;
                bindings.push(date.substring(0, 7));
                break;
            }
            default:
                return new Response(JSON.stringify({ error: "Invalid period" }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
    }
    try {
        const query = `
            SELECT a.user_id, COUNT(a.id) as post_count, COALESCE(us.is_blocked, 0) as is_blocked
            FROM audios a LEFT JOIN user_status us ON a.user_id = us.user_id
            ${whereClause}
            GROUP BY a.user_id ORDER BY post_count DESC LIMIT 100`;
        const { results } = await env.MY_D1_DATABASE.prepare(query).bind(...bindings).all();
        return new Response(JSON.stringify(results || []), { headers: { 'Content-Type': 'application/json' }});
    } catch (e) {
        console.error("Error in handleGetRankings:", e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' }});
    }
}

async function handleListUserPosts(env, userId, params) {
    const searchText = params.get('searchText');
    let whereConditions = ['user_id = ?'];
    let bindings = [userId];
    if (searchText) {
        whereConditions.push('text_content LIKE ?');
        bindings.push(`%${searchText}%`);
    }
    const whereClause = `WHERE ${whereConditions.join(' AND ')}`;
    try {
        const query = `SELECT id, r2_key, model_name, text_content, created_at FROM audios ${whereClause} ORDER BY created_at DESC`;
        const { results } = await env.MY_D1_DATABASE.prepare(query).bind(...bindings).all();
        return new Response(JSON.stringify(results || []), { headers: { 'Content-Type': 'application/json' }});
    } catch (e) {
        console.error("Error in handleListUserPosts:", e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' }});
    }
}

async function handleDeletePost(env, postId) {
    try {
        const stmt = env.MY_D1_DATABASE.prepare(`SELECT r2_key FROM audios WHERE id = ?`);
        const post = await stmt.bind(postId).first();
        if (!post) return new Response(JSON.stringify({ error: "Post not found" }), { status: 404, headers: { 'Content-Type': 'application/json' }});
        await env.MY_R2_BUCKET.delete(post.r2_key);
        await env.MY_D1_DATABASE.prepare(`DELETE FROM audios WHERE id = ?`).bind(postId).run();
        return new Response(JSON.stringify({ success: true, deleted_post_id: postId }), { headers: { 'Content-Type': 'application/json' }});
    } catch (e) {
        console.error("Error in handleDeletePost:", e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' }});
    }
}

async function handleDeleteAllPosts(env, userId) {
    try {
        const { results } = await env.MY_D1_DATABASE.prepare(`SELECT r2_key FROM audios WHERE user_id = ?`).bind(userId).all();
        if (!results || results.length === 0) return new Response(JSON.stringify({ message: "No posts to delete." }), { status: 200, headers: { 'Content-Type': 'application/json' }});
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