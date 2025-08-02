// functions/synthesize.js

async function handleRequest(context) {
    const { env } = context;
    const body = await context.request.json();
    const { model_id, texts, style_name, style_strength } = body;

    // --- バリデーション ---
    if (!texts || !Array.isArray(texts) || texts.length === 0) {
        return new Response("リクエストボディに 'texts' (配列) が必要です。", { status: 400 });
    }
    if (model_id === undefined || model_id === null) {
        return new Response("リクエストボディに 'model_id' が必要です。", { status: 400 });
    }
    
    const targetUuid = env[`MODEL_UUID_${model_id}`];
    const apiKey = env.API_KEY;

    if (!apiKey) {
        return new Response("サーバー側の環境変数エラー: API_KEYが設定されていません。", { status: 500 });
    }
    if (!targetUuid) {
        return new Response(`サーバーエラー: モデルID ${model_id} に対応するUUIDが見つかりません。`, { status: 400 });
    }
    
    // Aivis APIへのリクエストを構築
    // API仕様に合わせて、複数テキストを結合するか、個別にリクエストするかを選択
    const requestPayload = {
        speaker_uuid: targetUuid,
        text: texts.join("\n"), // 複数テキストを改行で結合する例
        style: style_name,
        style_strength: style_strength,
    };

    const aivisApiUrl = "https://api.aivis-project.com/v1/text2speech";
    const aivisResponse = await fetch(aivisApiUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestPayload)
    });

    if (!aivisResponse.ok) {
        return new Response(`Aivis APIエラー: ${await aivisResponse.text()}`, { status: aivisResponse.status });
    }

    // APIからのレスポンスをフロントエンドが期待する形式に変換
    const aivisData = await aivisResponse.json();
    
    // Aivis APIが個別の音声データを配列で返すことを想定した処理例
    const results = texts.map((text, index) => {
        const audioData = aivisData[index];
        if (audioData) {
            return {
                status: 'success',
                text: text,
                audio_base64: audioData.audio_base64,
                content_type: audioData.content_type || 'audio/opus'
            };
        }
        return {
            status: 'error',
            text: text,
            reason: 'APIから対応する音声データが返されませんでした。'
        };
    });

    return new Response(JSON.stringify(results), {
        headers: { 'Content-Type': 'application/json' }
    });
}

export async function onRequest(context) {
    if (context.request.method !== "POST") {
        return new Response("POSTメソッドを使用してください", { status: 405 });
    }
    try {
        return await handleRequest(context);
    } catch (e) {
        return new Response(`サーバー内部で予期せぬエラーが発生しました: ${e.message}`, { status: 500 });
    }
}