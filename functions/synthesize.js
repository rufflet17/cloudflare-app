// functions/synthesize.js

/**
 * Aivis API v1/tts/synthesize に単一の音声合成リクエストを送信するヘルパー関数
 * @param {string} text - 合成するテキスト
 * @param {string} modelUuid - モデルのUUID
 * @param {string} apiKey - APIキー
 * @param {object} options - スタイル名と強度を含むオブジェクト
 * @returns {Promise<object>} フロントエンドに返すための結果オブジェクト
 */
async function synthesizeSingleText(text, modelUuid, apiKey, options) {
    const { style_name, style_strength } = options;
    
    // APIエンドポイントを新しいものに設定
    const aivisApiUrl = "https://api.aivis-project.com/v1/tts/synthesize";

    // ★★★ 修正点: `speaker_uuid` を含めず、`model_uuid` のみを使用 ★★★
    const requestPayload = {
        text: text,
        model_uuid: modelUuid, // model_uuidのみを必須項目として送信
    };
    
    // スタイル名が有効な場合のみペイロードに追加
    if (style_name && style_name !== "取得失敗") {
        requestPayload.style_name = style_name;
        // style_strength を emotional_intensity にマッピング
        if (style_strength !== null && style_strength !== undefined) {
            requestPayload.emotional_intensity = style_strength;
        }
    }
    
    try {
        const aivisResponse = await fetch(aivisApiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestPayload)
        });

        if (!aivisResponse.ok) {
            const errorText = await aivisResponse.text();
            return {
                status: 'error',
                text: text,
                reason: `APIエラー (${aivisResponse.status}): ${errorText}`
            };
        }

        const aivisData = await aivisResponse.json();
        
        // APIのレスポンス形式に合わせてキーを調整
        return {
            status: 'success',
            text: text, 
            audio_base64: aivisData.audio_base64 || aivisData.audio,
            content_type: aivisData.content_type || 'audio/opus'
        };

    } catch (e) {
        return {
            status: 'error',
            text: text,
            reason: `リクエスト処理中にエラーが発生: ${e.message}`
        };
    }
}


/**
 * メインのリクエストハンドラー
 */
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
    
    // ★★★ 修正点: 環境変数から単一のUUIDを取得 (元のシンプルな形式に戻す) ★★★
    const targetModelUuid = env[`MODEL_UUID_${model_id}`];
    const apiKey = env.API_KEY;

    if (!apiKey) {
        return new Response("サーバー側の環境変数エラー: API_KEYが設定されていません。", { status: 500 });
    }
    if (!targetModelUuid) {
        return new Response(`サーバーエラー: モデルID ${model_id} のUUIDが見つかりません。`, { status: 400 });
    }
    
    // --- 複数テキストのAPIリクエストを並行して実行 ---
    const options = { style_name, style_strength };
    
    const results = await Promise.all(
        texts.map(text => synthesizeSingleText(text, targetModelUuid, apiKey, options))
    );

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
