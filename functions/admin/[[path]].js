// functions/admin/[[path]].js

async function verifyAdminToken(token, env) {
    // この関数は環境に合わせて、Firebase Admin SDKなどを使用した厳格な検証ロジックに置き換えてください。
    // この例では簡略化しています。
    try {
        // Firebase Admin SDK を使用する場合の例
        // const admin = require('firebase-admin');
        // if (admin.apps.length === 0) {
        //   admin.initializeApp({ credential: admin.credential.cert(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)) });
        // }
        // const decodedToken = await admin.auth().verifyIdToken(token); // Firebase ID Tokenの場合
        // return decodedToken.admin ? decodedToken : null;
        return token ? { admin: true } : null; // 開発用の簡易検証
    } catch(e) {
        console.error("Token verification failed:", e);
        return null;
    }
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

    // --- 新しいエンドポイント ---
    if (path === '/api/users/muted-list' && method === 'GET') {
        return handleGetStatusUsers(env, 'muted');
    }
    if (path === '/api/users/blocked-list' && method === 'GET') {
        return handleGetStatusUsers(env, 'blocked');
    }
    // -------------------------

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
    if (path.startsWith('/api/users/') && path.endsWith('/mute') && method === 'POST') {
        return handleSetMuteStatus(env, path.split('/')[3], true);
    }
    if (path.startsWith('/api/users/') && path.endsWith('/unmute') && method === 'POST') {
        return handleSetMuteStatus(env, path.split('/')[3], false);
    }
    
    return new Response(JSON.stringify({ error: "Admin API Route Not Found" }), { status: 404, headers: { 'Content-Type': 'application/json' }});
}


// --- 新しいハンドラ ---
async function handleGetStatusUsers(env, type) {
    try {
        let whereClause;
        if (type === 'muted') {
            whereClause = 'WHERE us.is_muted = 1';
        } else if (type === 'blocked') {
            whereClause = 'WHERE us.is_blocked = 1';
        } else {
            return new Response(JSON.stringify({ error: 'Invalid type' }), { status: 400 });
        }

        const query = `
            SELECT 
                us.user_id,
                us.is_muted,
                us.is_blocked,
                p.username
            FROM user_status AS us
            LEFT JOIN user_profiles AS p ON us.user_id = p.user_id
            ${whereClause}
            ORDER BY p.username ASC
        `;
        const { results } = await env.MY_D1_DATABASE.prepare(query).all();
        return new Response(JSON.stringify({ users: results }), { headers: { 'Content-Type': 'application/json' } });
    } catch(e) {
        console.error(`Error in handleGetStatusUsers (${type}):`, e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}
// ----------------------


// --- 既存のAPI実装 (変更なし) ---

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
                p.username,
                us.is_blocked, us.is_muted
            FROM audios AS a
            LEFT JOIN user_profiles AS p ON a.user_id = p.user_id
            LEFT JOIN user_status AS us ON a.user_id = us.user_id
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
                p.username,
                us.is_blocked, us.is_muted
            FROM audios AS a
            LEFT JOIN user_profiles AS p ON a.user_id = p.user_id
            LEFT JOIN user_status AS us ON a.user_id = us.user_id
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
                // R2のdeleteは最大1000キーまでなので、必要に応じてチャンクに分割する
                const chunkSize = 1000;
                for (let i = 0; i < keysToDelete.length; i += chunkSize) {
                    const chunk = keysToDelete.slice(i, i + chunkSize);
                    await env.MY_R2_BUCKET.delete(chunk);
                }
            }
        }
        const { count } = await env.MY_D1_DATABASE.prepare(`DELETE FROM audios WHERE user_id = ?`).bind(userId).run();
        return new Response(JSON.stringify({ success: true, deleted_count: count }), { headers: { 'Content-Type': 'application/json' }});
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

async function handleSetMuteStatus(env, userId, isMuted) {
     try {
        await env.MY_D1_DATABASE.prepare(
            `INSERT INTO user_status (user_id, is_muted, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(user_id) DO UPDATE SET is_muted = excluded.is_muted, updated_at = CURRENT_TIMESTAMP`
        ).bind(userId, isMuted ? 1 : 0).run();
        return new Response(JSON.stringify({ success: true, user_id: userId, is_muted: isMuted }), { headers: { 'Content-Type': 'application/json' }});
     } catch (e) {
        console.error("Error in handleSetMuteStatus:", e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' }});
    }
}