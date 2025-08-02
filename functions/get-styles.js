// functions/get-styles.js

export async function onRequest(context) {
  // GETメソッド以外は受け付けない
  if (context.request.method !== "GET") {
    return new Response("GETメソッドを使用してください", { status: 405 });
  }

  try {
    const { env, request } = context;
    const url = new URL(request.url);
    // クエリパラメータから 'id' を取得
    const modelId = url.searchParams.get('id');

    // 'id' が指定されていない、または数値に変換できない場合はエラー
    if (!modelId || isNaN(parseInt(modelId, 10))) {
      return new Response("クエリパラメータ 'id' が必要です。例: ?id=1", { status: 400 });
    }

    // 環境変数からAPIキーとモデルのUUIDを取得
    const apiKey = env.API_KEY;
    const targetModelUuid = env[`MODEL_UUID_${modelId}`];

    // 必要な環境変数が設定されているかチェック
    if (!apiKey) {
      console.error("環境変数エラー: API_KEYが設定されていません。");
      return new Response("サーバー側の設定エラーです。", { status: 500 });
    }
    if (!targetModelUuid) {
      console.error(`環境変数エラー: MODEL_UUID_${modelId} が見つかりません。`);
      return new Response(`指定されたモデルID [${modelId}] に対応する設定が見つかりません。`, { status: 404 });
    }

    // ★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★
    //
    //                         ここからが修正箇所です
    //
    // ★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★

    // 1. 【修正点】APIドキュメントに基づいた正しいエンドポイントを指定します。
    //    特定のモデル情報を取得するため、URLにモデルのUUIDを含めます。
    const aivisModelApiUrl = `https://api.aivis-project.com/v1/models/${targetModelUuid}`;

    // 2. Aivis APIへリクエストを送信します。
    const aivisResponse = await fetch(aivisModelApiUrl, {
      method: 'GET',
      headers: {
        "Authorization": `Bearer ${apiKey}`,
      },
    });

    // 3. APIからのレスポンスをチェックします。
    if (!aivisResponse.ok) {
      const errorText = await aivisResponse.text();
      // 404 (Not Found) の場合は、UUIDが間違っている可能性が高いです。
      if (aivisResponse.status === 404) {
        return new Response(`Aivis APIエラー: 指定されたUUID [${targetModelUuid}] のモデルが見つかりませんでした。`, { status: 404 });
      }
      // その他のエラー
      return new Response(`Aivis API (${aivisModelApiUrl}) でエラーが発生しました (ステータス: ${aivisResponse.status}): ${errorText}`, { status: aivisResponse.status });
    }

    // 4. 【修正点】レスポンスのJSONから直接モデル情報を取得します。
    //    全件取得して探す処理 (find) は不要になります。
    const modelInfo = await aivisResponse.json();

    // 5. モデル情報からスタイル(styles)のリストを抽出します。
    //    stylesプロパティが存在しない場合に備えて、デフォルト値として空配列 `[]` を設定します。
    const styles = modelInfo.styles || [];

    // 6. 取得したスタイル情報をJSON形式で返します。
    return new Response(JSON.stringify(styles), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (e) {
    // 予期せぬエラーが発生した場合の処理
    console.error("サーバー内部エラー:", e);
    return new Response(`サーバー内部で予期せぬエラーが発生しました: ${e.message}`, { status: 500 });
  }
}
