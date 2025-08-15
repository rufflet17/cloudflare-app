// functions/tasks/update-timeline-cache.js

/**
 * Cloudflare Pages Cron Trigger Handler
 * 
 * この関数は設定されたスケジュール（例：1分ごと）に基づいて自動的に実行されます。
 * 役割：
 * 1. D1データベースから最新1000件の投稿メタデータを取得します。
 * 2. 取得したデータをJSON形式の文字列に変換します。
 * 3. 変換したJSON文字列をKVに保存し、全ユーザー共通のタイムラインキャッシュとして利用できるようにします。
 */
export async function onSchedule(context) {
  console.log("Cron Job: Starting timeline cache update...");

  // 環境変数からD1とKVのバインディングを取得
  const { env } = context;

  // 重要：D1とKVのバインディングが設定されているか確認
  if (!env.MY_D1_DATABASE || !env.MY_KV_NAMESPACE) {
    console.error("Cron Job Error: D1 or KV binding is not configured in Cloudflare dashboard.");
    return;
  }

  try {
    // D1データベースに接続し、クエリを準備します。
    const query = `
      SELECT
        a.id, a.r2_key, a.user_id, a.model_name, a.text_content, a.created_at, p.username
      FROM audios AS a
      LEFT JOIN user_profiles AS p ON a.user_id = p.user_id
      WHERE a.is_deleted = 0
      ORDER BY a.created_at DESC
      LIMIT 1000;
    `;

    // クエリを実行して結果を取得
    const { results } = await env.MY_D1_DATABASE.prepare(query).all();

    if (results && results.length > 0) {
      const timelineJsonString = JSON.stringify(results);

      // KVに 'timeline_latest_1000' というキーでJSON文字列を保存
      await env.MY_KV_NAMESPACE.put('timeline_latest_1000', timelineJsonString);
      console.log(`Cron Job: Successfully updated timeline cache with ${results.length} posts.`);
    } else {
      console.log("Cron Job: No posts found to update cache.");
    }
  } catch (error) {
    console.error("Cron Job: Failed to update timeline cache.");
    console.error(error);
  }
}