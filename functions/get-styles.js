// functions/get-styles.js

export async function onRequest(context) {
  if (context.request.method !== "GET") {
    return new Response("GETメソッドを使用してください", { status: 405 });
  }
  
  try {
    const { env, request } = context;
    const url = new URL(request.url);
    const modelId = parseInt(url.searchParams.get('id'), 10);

    if (isNaN(modelId)) {
      return new Response("クエリパラメータ 'id' が必要です。", { status: 400 });
    }

    const targetUuid = env[`MODEL_UUID_${modelId}`];
    const apiKey = env.API_KEY;

    if (!apiKey) {
      return new Response("サーバー側の環境変数エラー: API_KEYが設定されていません。", { status: 500 });
    }
    if (!targetUuid) {
      return new Response(`サーバーエラー: モデルID ${modelId} に対応するUUIDが見つかりません。`, { status: 404 });
    }

    const aivisModelApiUrl = `https://api.aivis-project.com/v1/aivms/${targetUuid}`;
    
    const aivisResponse = await fetch(aivisModelApiUrl, {
      method: 'GET',
      headers: { 
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
    });

    if (!aivisResponse.ok) {
      const errorText = await aivisResponse.text();
      return new Response(`Aivis APIエラー (ステータス: ${aivisResponse.status}): ${errorText}`, { status: aivisResponse.status });
    }
    
    const modelData = await aivisResponse.json();
    
    // スタイルを抽出してユニークにする
    const allStyles = (modelData.speakers || []).flatMap(speaker => speaker.styles || []);
    const uniqueStyles = allStyles.reduce((acc, current) => {
      if (!acc.find(item => item.name === current.name)) {
        acc.push(current);
      }
      return acc;
    }, []);
    
    return new Response(JSON.stringify(uniqueStyles), { 
      headers: { 'Content-Type': 'application/json' } 
    });

  } catch (e) {
    return new Response(`サーバー内部で予期せぬエラーが発生しました: ${e.message}`, { status: 500 });
  }
}