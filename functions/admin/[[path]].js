// functions/admin/[[path]].js

async function verifyAdminToken(token, env) {
    // 本番環境では、Firebase Admin SDKで発行したカスタムトークンを厳格に検証するロ-ジックが必須です。
    return token ? { admin: true } : null;
}

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const method = request.method;

    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ error: "Unauthorized: Missing token" }), { status: 401, headers: { 'Content-Type': 'application/json' }});
    }
    const token = authHeader.substring(7);
    const decodedToken = await verifyAdminToken(token, env);
    if (!decodedToken || !decodedToken.admin) {
        return new Response(JSON.stringify({ error: "Unauthorized: Invalid or non-admin token" }), { status: 403, headers: { 'Content-Type': 'application/json' }});
    }

    const path = url.pathname.replace('/admin', '');

    if (path === '/api/posts/since' && method === 'GET') {
        return handleGetPostsSince(env, url.searchParams);
    }
    if (path === '/api/posts/all' && method === 'GET') {
        return handleGetAllPosts(env, url.searchParams);
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
        return handleSetBlockStatus(env, path.split('/')[3], true);
    }
    if (path.startsWith('/api/users/') && path.endsWith('/unblock') && method === 'POST') {
        return handleSetBlockStatus(env, path.split('/')[3], false);
    }
    
    return new Response(JSON.stringify({ error: "Admin API Route Not Found" }), { status: 404, headers: { 'Content-Type': 'application/json' }});
}

// --- API実装 ---

async function handleGetPostsSince(env, params) {
    const limit = parseInt(params.get('limit'), 10) || 1000;
    const cursor_ts = params.get('cursor_ts'); 
    const cursor_id = params.get('cursor_id');

    if (!cursor_ts || !cursor_id) {
        return new Response(JSON.stringify({ posts: [], has_more: false }), { 
            headers: { 'Content-Type': 'application/json' }
        });
    }
    try {
        const whereClause = 'WHERE (a.created_at > ?) OR (a.created_at = ? AND a.id > ?)';
        const bindings = [cursor_ts, cursor_ts, cursor_id];
        const query = `
            SELECT 
                a.id, a.r2_key, a.user_id, a.model_name, a.text_content, a.created_at, a.is_deleted, a.deleted_at,
                p.username
            FROM audios AS a
            LEFT JOIN user_profiles AS p ON a.user_id = p.user_id
            ${whereClause} 
            ORDER BY a.created_at ASC, a.id ASC
            LIMIT ?`;
        
        const { results } = await env.MY_D1_DATABASE.prepare(query).bind(...bindings, limit + 1).all();
        const has_more = results.length > limit;
        const posts = results.slice(0, limit);

        return new Response(JSON.stringify({ posts, has_more }), { 
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        console.error("Error in handleGetPostsSince:", e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' }});
    }
}

async function handleGetAllPosts(env, params) {
    const limit = parseInt(params.get('limit'), 10) || 1000;
    const cursor_ts = params.get('cursor_ts'); 
    const cursor_id = params.get('cursor_id');

    let whereClause = '';
    let bindings = [];

    if (cursor_ts && cursor_id) {
        whereClause = 'WHERE (a.created_at < ?) OR (a.created_at = ? AND a.id < ?)';
        bindings.push(cursor_ts, cursor_ts, cursor_id);
    }

    try {
        const query = `
            SELECT 
                a.id, a.r2_key, a.user_id, a.model_name, a.text_content, a.created_at, a.is_deleted, a.deleted_at,
                p.username
            FROM audios AS a
            LEFT JOIN user_profiles AS p ON a.user_id = p.user_id
            ${whereClause} 
            ORDER BY a.created_at DESC, a.id DESC
            LIMIT ?`;
        
        const { results } = await env.MY_D1_DATABASE.prepare(query).bind(...bindings, limit + 1).all();
        
        const has_more = results.length > limit;
        const posts = results.slice(0, limit);

        return new Response(JSON.stringify({ posts, has_more }), { 
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        console.error("Error in handleGetAllPosts:", e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' }});
    }
}

async function handleDeletePost(env, postId) {
    try {
        const post = await env.MY_D1_DATABASE.prepare(`SELECT r2_key FROM audios WHERE id = ?`).bind(postId).first();
        if (!post) {
            return new Response(JSON.stringify({ error: "Post not found" }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }
        
        if (post.r2_key) {
            await env.MY_R2_BUCKET.delete(post.r2_key);
        }
        await env.MY_D1_DATABASE.prepare(`DELETE FROM audios WHERE id = ?`).bind(postId).run();
        
        return new Response(JSON.stringify({ success: true, message: "Post permanently deleted." }), { headers: { 'Content-Type': 'application/json' }});
    } catch (e) {
        console.error("Error in handleDeletePost:", e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' }});
    }
}

async function handleDeleteAllPosts(env, userId) {
    try {
        const { results } = await env.MY_D1_DATABASE.prepare(`SELECT r2_key FROM audios WHERE user_id = ?`).bind(userId).all();
        if (results && results.length > 0) {
            const keysToDelete = results.map(row => row.r2_key).filter(Boolean);
            if (keysToDelete.length > 0) {
                await env.MY_R2_BUCKET.delete(keysToDelete);
            }
            await env.MY_D1_DATABASE.prepare(`DELETE FROM audios WHERE user_id = ?`).bind(userId).run();
            return new Response(JSON.stringify({ success: true, deleted_count: keysToDelete.length }), { headers: { 'Content-Type': 'application/json' }});
        }
        return new Response(JSON.stringify({ message: "No posts to delete." }), { headers: { 'Content-Type': 'application/json' }});
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