// 1. 型定義 (変更なし)
// -----------------------------------------------------------------------------
interface Env {
  MY_KV_NAMESPACE2: KVNamespace;
  MY_D1_DATABASE2: D1Database;
  MY_R2_BUCKET2: R2Bucket;
}
interface Thread { id: number; title: string; post_count: number; last_updated: string; }
interface Post { id: number; thread_id: number; post_number: number; author: string; body: string; created_at: string; }


// 2. メインのハンドラ（ルーター機能）- ★デバッグコード追加★
// -----------------------------------------------------------------------------
export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // ★★★ここからデバッグコード★★★
  console.log("--- New Request Received ---");
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Path: ${path}, Method: ${method}`);
  
  // envオブジェクトの中身をチェック
  const availableBindings = Object.keys(env);
  console.log("Available Bindings in env:", availableBindings.length > 0 ? availableBindings.join(', ') : 'None');
  
  // D1とKVのバインディングが存在するかどうかを明確にログ出力
  const isD1Bound = env.MY_D1_DATABASE2 !== undefined;
  const isKVBound = env.MY_KV_NAMESPACE2 !== undefined;
  console.log(`D1 Binding (MY_D1_DATABASE2) is defined: ${isD1Bound}`);
  console.log(`KV Binding (MY_KV_NAMESPACE2) is defined: ${isKVBound}`);
  console.log("----------------------------");

  if (!isD1Bound || !isKVBound) {
    const errorMsg = "Server configuration error: Required database or KV bindings are missing.";
    console.error(errorMsg);
    return new Response(JSON.stringify({ error: errorMsg }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  // ★★★ここまでデバッグコード★★★

  try {
    // GET /api/threads
    if (method === 'GET' && path === '/api/threads') {
      return await getThreads(env);
    }
    // POST /api/threads
    if (method === 'POST' && path === '/api/threads') {
      return await createThread(request, env);
    }
    // GET /api/threads/:id
    const threadMatch = path.match(/^\/api\/threads\/(\d+)$/);
    if (method === 'GET' && threadMatch) {
      const threadId = parseInt(threadMatch[1], 10);
      return await getThreadById(request, env, context, threadId);
    }
    // POST /api/threads/:id/posts
    const postMatch = path.match(/^\/api\/threads\/(\d+)\/posts$/);
    if (method === 'POST' && postMatch) {
      const threadId = parseInt(postMatch[1], 10);
      return await createPost(request, env, context, threadId);
    }
    return new Response('Not Found', { status: 404 });
  } catch (e: any) {
    // ★★★ここが重要なエラー詳細返却コード★★★
    console.error("An unexpected error occurred:", e);
    const errorResponse = {
      error: "An unexpected error occurred inside the API.",
      message: e.message,
      stack: e.stack,
    };
    return new Response(JSON.stringify(errorResponse), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};


// 3. 各APIエンドポイントの個別処理 - ★デバッグコード追加★
// -----------------------------------------------------------------------------
// 各関数のcatchブロックを修正し、エラーの詳細を上位にスローするようにします

// GET /api/threads
async function getThreads(env: Env) {
  try {
    const { results } = await env.MY_D1_DATABASE2.prepare(
      "SELECT id, title, post_count, last_updated FROM threads ORDER BY last_updated DESC LIMIT 50"
    ).all<Thread>();
    return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("Error in getThreads:", e);
    throw e; // エラーを上位のtry-catchに投げる
  }
}

// POST /api/threads
async function createThread(request: Request, env: Env) {
  try {
    const { title, author, body } = await request.json<{ title: string; author: string; body: string }>();
    if (!title || !body) return new Response("タイトルと本文は必須です", { status: 400 });

    const threadResult = await env.MY_D1_DATABASE2.prepare("INSERT INTO threads (title) VALUES (?) RETURNING id").bind(title).first<{ id: number }>();
    const newThreadId = threadResult.id;
    await env.MY_D1_DATABASE2.prepare("INSERT INTO posts (thread_id, post_number, author, body) VALUES (?, 1, ?, ?)")
      .bind(newThreadId, author || '名無しさん', body).run();

    return new Response(JSON.stringify({ id: newThreadId }), { headers: { "Content-Type": "application/json" }, status: 201 });
  } catch (e) {
    console.error("Error in createThread:", e);
    throw e;
  }
}

// GET /api/threads/:id
async function getThreadById(request: Request, env: Env, context: EventContext<Env, any, any>, threadId: number) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url), request);
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) return cachedResponse;

  try {
    const threadInfo = await env.MY_D1_DATABASE2.prepare("SELECT * FROM threads WHERE id = ?").bind(threadId).first<Thread>();
    if (!threadInfo) return new Response("スレッドが見つかりません", { status: 404 });

    let snapshotPosts: Post[] = [];
    let lastSnapshotNumber = 0;
    for (let i = Math.floor(threadInfo.post_count / 100) * 100; i > 0; i -= 100) {
      const kvKey = `thread-${threadId}-snapshot-${i}`;
      const snapshotJson = await env.MY_KV_NAMESPACE2.get(kvKey);
      if (snapshotJson) {
        snapshotPosts = JSON.parse(snapshotJson);
        lastSnapshotNumber = i;
        break;
      }
    }

    const { results: newPosts } = await env.MY_D1_DATABASE2.prepare(
      "SELECT * FROM posts WHERE thread_id = ? AND post_number > ? ORDER BY post_number ASC"
    ).bind(threadId, lastSnapshotNumber).all<Post>();

    const allPosts = [...snapshotPosts, ...newPosts];
    const responsePayload = { thread: threadInfo, posts: allPosts };
    const response = new Response(JSON.stringify(responsePayload), { headers: { "Content-Type": "application/json" } });
    
    response.headers.set("Cache-Control", "public, max-age=300");
    context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (e) {
    console.error("Error in getThreadById:", e);
    throw e;
  }
}

// POST /api/threads/:id/posts
async function createPost(request: Request, env: Env, context: EventContext<Env, any, any>, threadId: number) {
  try {
    const { author, body } = await request.json<{ author: string; body: string }>();
    if (!body) return new Response("本文は必須です", { status: 400 });

    const results = await env.MY_D1_DATABASE2.batch([
      env.MY_D1_DATABASE2.prepare("UPDATE threads SET post_count = post_count + 1, last_updated = CURRENT_TIMESTAMP WHERE id = ? RETURNING post_count").bind(threadId)
    ]);
    const newPostCount = results[0].results[0].post_count as number;

    await env.MY_D1_DATABASE2.prepare("INSERT INTO posts (thread_id, post_number, author, body) VALUES (?, ?, ?, ?)")
      .bind(threadId, newPostCount, author || '名無しさん', body).run();

    if (newPostCount > 0 && newPostCount % 100 === 0) {
      context.waitUntil(createAndStoreSnapshot(env, threadId, newPostCount));
    }

    const cache = caches.default;
    const cacheUrl = new URL(request.url);
    cacheUrl.pathname = `/api/threads/${threadId}`;
    context.waitUntil(cache.delete(new Request(cacheUrl)));
    
    return new Response(JSON.stringify({ success: true, postCount: newPostCount }), { status: 201 });
  } catch (e) {
    console.error("Error in createPost:", e);
    throw e;
  }
}


// 4. ヘルパー関数 (変更なし)
// -----------------------------------------------------------------------------
async function createAndStoreSnapshot(env: Env, threadId: number, postCount: number) {
  try {
    const { results } = await env.MY_D1_DATABASE2.prepare(
      "SELECT * FROM posts WHERE thread_id = ? AND post_number <= ? ORDER BY post_number ASC"
    ).bind(threadId, postCount).all<Post>();

    if (results && results.length > 0) {
      const kvKey = `thread-${threadId}-snapshot-${postCount}`;
      await env.MY_KV_NAMESPACE2.put(kvKey, JSON.stringify(results), { expirationTtl: 86400 * 7 });
    }
  } catch (e) {
    console.error(`Failed to create snapshot for thread ${threadId}:`, e);
  }
}