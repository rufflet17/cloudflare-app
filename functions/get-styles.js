// functions/get-styles.js

export async function onRequest(context) {
  // GETメソッド以外は受け付けない
  if (context.request.method !== "GET") {
    return new Response("GETメソッドを使用してください", { status: 405 });
  }

  try {
    // 環境変数からAPIキーとモデルUUIDを取得
    const { API_KEY, MODEL_UUID } = context.env;

    // 環境変数が設定されているかチェック
    if (!API_KEY || !MODEL_UUID) {
      const missingVars = [];
      if (!API_KEY) missingVars.push("API_KEY");
      if (!MODEL_UUID) missingVars.push("MODEL_UUID");
      const errorMessage = `サーバー側の環境変数設定エラー: ${missingVars.join(", ")} が設定されていません。`;
      console.error(errorMessage); // サーバーログにもエラーを残す
      return new Response(errorMessage, { status: 500 });
    }
    
    // 環境変数から取得した値の前後の不要な空白を除去
    const trimmedModelUuid = MODEL_UUID.trim();
    const trimmedApiKey = API_KEY.trim();

    // ★★★ 修正点 ★★★
    // APIエンドポイントを /v1/models/ から /v1/aivms/ に修正
    const aivisModelApiUrl = `https://api.aivis-project.com/v1/aivms/${trimmedModelUuid}`;

    // Aivis APIにリクエストを送信
    const aivisResponse = await fetch(aivisModelApiUrl, {
      method: "GET",
      headers: { 
        "Authorization": `Bearer ${trimmedApiKey}`,
        "Content-Type": "application/json"
      },
    });

    // APIからのレスポンスがエラーでないかチェック
    if (!aivisResponse.ok) {
      const errorText = await aivisResponse.text();
      const detailedErrorMessage = `Aivis APIエラー (ステータス: ${aivisResponse.status}): ${errorText}`;
      console.error(detailedErrorMessage);
      return new Response(detailedErrorMessage, { status: aivisResponse.status });
    }

    // レスポンスをJSONとしてパース
    const modelData = await aivisResponse.json();

    // レスポンスデータに `speakers` 配列が存在するかチェック
    if (!modelData.speakers || !Array.isArray(modelData.speakers)) {
      // speakersが存在しない場合、空の配列を返す
      console.warn(`モデルID: ${trimmedModelUuid} にはspeakersプロパティが存在しません。`);
      return new Response(JSON.stringify([]), { 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    // 全ての話者からスタイルを抽出し、一つの配列にまとめる
    // speaker.stylesが存在しない場合も考慮して `|| []` を追加
    const allStyles = modelData.speakers.flatMap(speaker => speaker.styles || []);

    // スタイル名で重複を排除する
    const uniqueStyles = allStyles.reduce((acc, current) => {
      // 既に同じ名前のスタイルが追加されていない場合のみ追加する
      if (!acc.find(item => item.name === current.name)) {
        acc.push(current);
      }
      return acc;
    }, []);

    // 取得・整形したスタイル一覧をJSON形式で返す
    return new Response(JSON.stringify(uniqueStyles), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (e) {
    // 予期せぬエラーが発生した場合の処理
    console.error(`サーバー内部で予期せぬエラーが発生しました: ${e.message}`);
    return new Response(`サーバー内部で予期せぬエラーが発生しました: ${e.message}`, { status: 500 });
  }
}
