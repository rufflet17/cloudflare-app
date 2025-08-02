// functions/get-styles.js

// Aivis APIの正しいスタイル一覧取得エンドポイント
const AIVIS_STYLES_API_URL = "https://api.aivis-project.com/v1/styles";

export async function onRequest(context) {
  if (context.request.method !== "GET") {
    return new Response("GETメソッドを使用してください", { status: 405 });
  }

  try {
    // 環境変数からAPIキーのみ取得（MODEL_UUIDは不要）
    const { API_KEY } = context.env;

    if (!API_KEY) {
      return new Response("サーバー側でAPIキーが設定されていません。", { status: 500 });
    }
    
    // Aivis APIのスタイル一覧取得エンドポイントを呼び出す
    const aivisResponse = await fetch(AIVIS_STYLES_API_URL, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
      },
    });

    if (!aivisResponse.ok) {
      const errorText = await aivisResponse.text();
      return new Response(`Aivis APIからのスタイル情報取得に失敗: ${errorText}`, { status: aivisResponse.status });
    }

    const stylesData = await aivisResponse.json();

    // Aivis APIから返されたJSON配列をそのままクライアントに返す
    return new Response(JSON.stringify(stylesData), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (e) {
    return new Response(`サーバー内部エラー: ${e.message}`, { status: 500 });
  }
}
