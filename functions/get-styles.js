// functions/get-styles.js (空白対策版)

export async function onRequest(context) {
  if (context.request.method !== "GET") {
    return new Response("GETメソッドを使用してください", { status: 405 });
  }

  try {
    const { API_KEY, MODEL_UUID } = context.env;

    if (!API_KEY || !MODEL_UUID) {
      // (エラーハンドリングは変更なし)
      const missingVars = [];
      if (!API_KEY) missingVars.push("API_KEY");
      if (!MODEL_UUID) missingVars.push("MODEL_UUID");
      const errorMessage = `サーバー側の環境変数設定エラー: ${missingVars.join(", ")} が設定されていません。`;
      return new Response(errorMessage, { status: 500 });
    }
    
    // ★★★★★ ここが修正点 ★★★★★
    // 環境変数から取得した値の前後の空白を trim() で自動的に除去します。
    const trimmedModelUuid = MODEL_UUID.trim();

    // trim() した安全な値を使ってURLを組み立てます。
    const aivisModelApiUrl = `https://api.aivis-project.com/v1/models/${trimmedModelUuid}`;

    const aivisResponse = await fetch(aivisModelApiUrl, {
      method: "GET",
      headers: { "Authorization": `Bearer ${API_KEY.trim()}` }, // APIキーも念のためtrim
    });

    if (!aivisResponse.ok) {
      const errorText = await aivisResponse.text();
      const detailedErrorMessage = `Aivis APIエラー (ステータス: ${aivisResponse.status}): ${errorText}`;
      return new Response(detailedErrorMessage, { status: aivisResponse.status });
    }

    const modelData = await aivisResponse.json();

    if (!modelData.speakers || !Array.isArray(modelData.speakers)) {
      return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
    }

    const allStyles = modelData.speakers.flatMap(speaker => speaker.styles || []);
    const uniqueStyles = allStyles.reduce((acc, current) => {
      if (!acc.find(item => item.name === current.name)) {
        acc.push(current);
      }
      return acc;
    }, []);

    return new Response(JSON.stringify(uniqueStyles), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (e) {
    return new Response(`サーバー内部で予期せぬエラーが発生しました: ${e.message}`, { status: 500 });
  }
}
