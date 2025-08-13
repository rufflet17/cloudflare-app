// backend/index.js

// firebase-adminのJWT検証機能を模倣するためのヘルパー関数群
async function verifyAdminToken(token, env) {
    // 本番環境では、Firebase Admin SDKで発行したカスタムトークンを厳格に検証するロ-ジックが必須です。
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

    if (path === '/api/posts/all' && method === 'GET') {
        return handleGetAllPosts(env, url.searchParams);
    }
    if (path.startsWith('/api/posts/') && method === 'DELETE') {
        const postId = path.split('/')[3];
        return handleDeletePost(env, postId);
    }
    // 以下は、管理者ツールから直接使わない可能性がある補助的な機能
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

/**
 * 【最重要】管理者ツールが全データをローカルに同期するためのAPI。
 * 論理削除されたものも含め、すべての投稿データをページネーションで取得する。
 */
async function handleGetAllPosts(env, params) {
    const limit = parseInt(params.get('limit'), 10) || 1000;
    const cursor = params.get('cursor'); 

    let whereClause = '';
    let bindings = [];

    if (cursor) {
        whereClause = 'WHERE created_at < ?';
        bindings.push(cursor);
    }

    try {
        const query = `
            SELECT id, r2_key, user_id, model_name, text_content, created_at, is_deleted, deleted_at FROM audios 
            ${whereClause} 
            ORDER BY created_at DESC 
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

/**
 * 【重要】管理者ツールから特定の投稿を完全に削除するためのAPI（物理削除）。
 */
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


/**
 * 【補助機能】管理者ツールから特定のユーザーの全投稿を完全に削除するAPI。
 */
async function handleDeleteAllPosts(env, userId) {
    try {
        // 論理削除済みも含め、そのユーザーの全投稿を取得
        const { results } = await env.MY_D1_DATABASE.prepare(`SELECT r2_key FROM audios WHERE user_id = ?`).bind(userId).all();
        
        if (results && results.length > 0) {
            const keysToDelete = results.map(row => row.r2_key).filter(Boolean);
            if (keysToDelete.length > 0) {
                await env.MY_R2_BUCKET.delete(keysToDelete);
            }
            // D1からレコードを完全に削除
            await env.MY_D1_DATABASE.prepare(`DELETE FROM audios WHERE user_id = ?`).bind(userId).run();
            return new Response(JSON.stringify({ success: true, deleted_count: keysToDelete.length }), { headers: { 'Content-Type': 'application/json' }});
        }
        return new Response(JSON.stringify({ message: "No posts to delete." }), { headers: { 'Content-Type': 'application/json' }});
    } catch (e) {
        console.error("Error in handleDeleteAllPosts:", e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' }});
    }
}

/**
 * 【補助機能】管理者ツールからユーザーをブロック/ブロック解除するAPI。
 */
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