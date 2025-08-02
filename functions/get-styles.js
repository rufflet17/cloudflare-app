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

    // ★★★ 修正点1: 変数名を明確化 ★★★
    // 環境変数に設定されているのは「話者」のUUIDなので、変数名をそれに合わせます。
    const targetSpeakerUuid = env[`MODEL_UUID_${modelId}`];
    const apiKey = env.API_KEY;

    if (!apiKey) {
      return new Response("サーバー側の環境変数エラー: API_KEYが設定されていません。", { status: 500 });
    }
    if (!targetSpeakerUuid) {
      return new Response(`サーバーエラー: モデルID ${modelId} に対応するUUIDが見つかりません。`, { status: 404 });
    }

    // ★★★ 修正点2: 呼び出すAPIのエンドポイントを /v1/speakers に変更 ★★★
    // これがスタイル一覧を取得するための正しいAPIです。
    const aivisSpeakersApiUrl = `https://api.aivis-project.com/v1/speakers`;
    
    const aivisResponse = await fetch(aivisSpeakersApiUrl, {
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
    
    // /v1/speakers は全話者のリストを配列で返します
    const allSpeakers = await aivisResponse.json();
    
    // ★★★ 修正点3: 全話者リストから、目的のUUIDを持つ話者を探す ★★★
    const targetSpeaker = allSpeakers.find(speaker => speaker.speaker_uuid === targetSpeakerUuid);

    if (!targetSpeaker) {
        // 目的の話者が見つからなかった場合
        return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
    }

    // 見つかった話者のスタイルリストを返す (ユニーク処理は不要)
    const styles = targetSpeaker.styles || [];
    
    return new Response(JSON.stringify(styles), { 
      headers: { 'Content-Type': 'application/json' } 
    });

  } catch (e) {
    return new Response(`サーバー内部で予期せぬエラーが発生しました: ${e.message}`, { status: 500 });
  }
}
