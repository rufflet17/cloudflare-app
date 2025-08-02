// functions/get-styles.js

export async function onRequest(context) {
  if (context.request.method !== "GET") {
    return new Response("GETメソッドを使用してください", { status: 405 });
  }

  try {
    const { API_KEY, MODEL_UUID } = context.env;

    if (!API_KEY || !MODEL_UUID) {
      const missingVars = [];
      if (!API_KEY) missingVars.push("API_KEY");
      if (!MODEL_UUID) missingVars.push("MODEL_UUID");
      const errorMessage = `サーバー側の環境変数設定エラー: ${missingVars.join(", ")} が設定されていません。Cloudflare Pagesのダッシュボードで設定を確認してください。`;
      return new Response(errorMessage, { status: 500 });
    }
    
    const aivisModelApiUrl = `https://api.aivis-project.com/v1/models/${MODEL_UUID}`;

    const aivisResponse = await fetch(aivisModelApiUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
      },
    });

    if (!aivisResponse.ok) {
      const errorText = await aivisResponse.text();
      const detailedErrorMessage = `Aivis APIエラー (ステータス: ${aivisResponse.status}): ${errorText}`;
      return new Response(detailedErrorMessage, { status: aivisResponse.status });
    }

    const modelData = await aivisResponse.json();

    // ★★★ ここからがスキーマ対応のロジックです ★★★

    // 1. モデルデータに `speakers` プロパティが存在するかチェック
    if (!modelData.speakers || !Array.isArray(modelData.speakers)) {
      // speakers が見つからない場合、空のスタイルリストを返すかエラーとする
      // ここでは空リストを返すことで、フロントエンドのエラーを防ぎます
      return new Response(JSON.stringify([]), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. すべての話者(speakers)が持つスタイルを一つの配列にまとめる
    const allStyles = modelData.speakers.flatMap(speaker => speaker.styles || []);
    
    // 3. スタイル名が重複している可能性があるので、重複を除去する
    const uniqueStyles = allStyles.reduce((acc, current) => {
      // acc（蓄積配列）に同じ名前のスタイルがなければ、current（現在のスタイル）を追加する
      if (!acc.find(item => item.name === current.name)) {
        acc.push(current);
      }
      return acc;
    }, []);

    // 4. 重複を除去したスタイルリストをクライアントに返す
    return new Response(JSON.stringify(uniqueStyles), {
      headers: { 'Content-Type': 'application/json' },
    });


  } catch (e) {
    const internalErrorMessage = `サーバー内部で予期せぬエラーが発生しました: ${e.message}`;
    return new Response(internalErrorMessage, { status: 500 });
  }
}
