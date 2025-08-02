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

    // ★★★ 修正点1: 変数名を元の 'targetUuid' に戻す ★★★
    // このAPIでは、モデル全体のUUIDを指定するため
    const targetUuid = env[`MODEL_UUID_${modelId}`];
    const apiKey = env.API_KEY;

    if (!apiKey) {
      return new Response("サーバー側の環境変数エラー: API_KEYが設定されていません。", { status: 500 });
    }
    if (!targetUuid) {
      return new Response(`サーバーエラー: モデルID ${modelId} に対応するUUIDが見つかりません。`, { status: 404 });
    }

    // ★★★ 修正点2: APIエンドポイントを古いコードの形式に戻す ★★★
    // URLの末尾に、目的のモデルのUUIDを埋め込みます
    const aivisModelApiUrl = `https://api.aivis-project.com/v1/aivm-models/${targetUuid}`;
    
    const aivisResponse = await fetch(aivisModelApiUrl, {
      method: 'GET',
      headers: { 
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
    });

    if (!aivisResponse.ok) {
      const errorText = await aivisResponse.text();
      return new Response(`Aivis API (${aivisModelApiUrl}) エラー (ステータス: ${aivisResponse.status}): ${errorText}`, { status: aivisResponse.status });
    }
    
    // ★★★ 修正点3: データ処理方法を古いコードの形式に戻す ★★★
    // APIから返ってくるのは「単一のモデル情報オブジェクト」
    const modelData = await aivisResponse.json();
    
    // そのオブジェクトの中から、話者(speakers)リストを取得し、
    // 全ての話者が持つスタイルを一つの配列にまとめる
    const allStyles = (modelData.speakers || []).flatMap(speaker => speaker.styles || []);
    
    // スタイル名で重複を排除する（複数の話者が同じスタイルを持つ場合のため）
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
