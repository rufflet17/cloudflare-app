// functions/get-styles.js (デバッグ用)

export async function onRequest(context) {
  // このファイルはGETリクエストのみを受け付けます
  if (context.request.method !== "GET") {
    return new Response("GETメソッドを使用してください", { status: 405 });
  }

  try {
    const { API_KEY, MODEL_UUID } = context.env;

    // 環境変数チェック
    if (!API_KEY || !MODEL_UUID) {
      return new Response("サーバー側の環境変数が設定されていません。", { status: 500 });
    }
    
    const aivisModelApiUrl = `https://api.aivis-project.com/v1/models/${MODEL_UUID}`;

    const aivisResponse = await fetch(aivisModelApiUrl, {
      method: "GET",
      headers: { "Authorization": `Bearer ${API_KEY}` },
    });

    if (!aivisResponse.ok) {
      const errorText = await aivisResponse.text();
      return new Response(`Aivis APIエラー (ステータス: ${aivisResponse.status}): ${errorText}`, { status: aivisResponse.status });
    }

    const modelData = await aivisResponse.json();

    // ★★★★★ ここからがデバッグ用の処理です ★★★★★

    // 1. Aivis APIから受け取ったJSONデータを、人間が読みやすい形に整形します。
    const prettyJsonString = JSON.stringify(modelData, null, 2); // `null, 2` でインデント付きの整形

    // 2. このJSONデータを、メッセージとしてフロントエンドに返します。
    const debugMessage = `【デバッグ情報】Aivis APIから以下のモデル情報を取得しました。この内容を開発者に伝えてください：\n\n${prettyJsonString}`;

    // 3. 意図的にエラーステータスで返すことで、フロントエンドの画面にこのメッセージを表示させます。
    return new Response(debugMessage, { status: 418 }); // 418 I'm a teapot (エラーとして扱われるステータスコード)

  } catch (e) {
    return new Response(`サーバー内部で予期せぬエラーが発生しました: ${e.message}`, { status: 500 });
  }
}
