// functions/get-styles.js

export async function onRequest(context) {
  // このAPIはGETリクエストのみを受け付けます
  if (context.request.method !== "GET") {
    return new Response("GETメソッドを使用してください", { status: 405 });
  }

  try {
    // 環境変数からAPIキーとモデルUUIDを取得
    const { API_KEY, MODEL_UUID } = context.env;

    if (!API_KEY || !MODEL_UUID) {
      return new Response("サーバー側でAPIキーまたはモデルUUIDが設定されていません。", { status: 500 });
    }
    
    // Aivis APIのモデル詳細取得エンドポイントを呼び出す
    const aivisModelApiUrl = `https://api.aivis-project.com/v1/models/${MODEL_UUID}`;

    const aivisResponse = await fetch(aivisModelApiUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
      },
    });

    if (!aivisResponse.ok) {
      const errorText = await aivisResponse.text();
      return new Response(`Aivis APIからのモデル情報取得に失敗: ${errorText}`, { status: aivisResponse.status });
    }

    const modelData = await aivisResponse.json();

    // モデル情報からスタイル配列を取得し、クライアントに返す
    // modelData.styles が存在しない場合に備えて、空の配列をデフォルト値とする
    const styles = modelData.styles || [];

    return new Response(JSON.stringify(styles), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (e) {
    return new Response(`サーバー内部エラー: ${e.message}`, { status: 500 });
  }
}
