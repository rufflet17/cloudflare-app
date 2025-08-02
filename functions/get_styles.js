// functions/get-styles.js

export async function onRequest(context) {
  if (context.request.method !== "GET") {
    return new Response("GETメソッドを使用してください", { status: 405 });
  }

  try {
    // ★★★ 環境変数からAPIキーと【MODEL_UUID】の両方を取得します ★★★
    const { API_KEY, MODEL_UUID } = context.env;

    if (!API_KEY || !MODEL_UUID) {
      return new Response("サーバー側でAPIキーまたはモデルUUIDが設定されていません。", { status: 500 });
    }
    
    // ★★★ 特定モデルの詳細情報を取得するエンドポイントを正しく指定します ★★★
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

    // ★★★ モデル情報JSONから `styles` プロパティ（配列）を取得します ★★★
    // この `styles` プロパティに、このモデルで利用可能なスタイル情報が含まれています。
    const styles = modelData.styles || [];

    // 取得したスタイル配列をクライアントに返します
    return new Response(JSON.stringify(styles), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (e) {
    return new Response(`サーバー内部エラー: ${e.message}`, { status: 500 });
  }
}
