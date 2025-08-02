// functions/synthesize.js

/**
 * Aivis APIに単一の音声合成リクエストを送信するヘルパー関数
 * @param {string} text - 合成するテキスト
 * @param {string} speaker_uuid - 話者のUUID
 * @param {string} apiKey - APIキー
 * @param {object} options - スタイル名と強度を含むオブジェクト
 * @returns {Promise<object>} フロントエンドに返すための結果オブジェクト
 */
async function synthesizeSingleText(text, speaker_uuid, apiKey, options) {
    const { style_name, style_strength } = options;
    const aivisApiUrl = "https://api.aivis-project.com/v1/text2speech";

    const requestPayload = {
        text: text,
        speaker_uuid: speaker_uuid,
    };
    
    // スタイル名が指定されている場合のみペイロードに追加
    if (style_name) {
        requestPayload.style_name = style_name;
        // スタイル強度はスタイル名がある場合のみ有効
        if (style_strength !== null && style_strength !== undefined) {
            requestPayload.style_strength = style_strength;
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
            // APIからのエラーメッセージを理由として返す
            return {
                status: 'error',
                text: text,
                reason: `APIエラー (${aivisResponse.status}): ${errorText}`
            };
        }

        const aivisData = await aivisResponse.json();
        
        // 成功した結果を返す
        return {
            status: 'success',
            text: aivisData.text, // APIが返したテキストを使用
            audio_base64: aivisData.audio_base64,
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
    
    const targetUuid = env[`MODEL_UUID_${model_id}`];
    const apiKey = env.API_KEY;

    if (!apiKey) {
        return new Response("サーバー側の環境変数エラー: API_KEYが設定されていません。", { status: 500 });
    }
    if (!targetUuid) {
        return new Response(`サーバーエラー: モデルID ${model_id} に対応するUUIDが見つかりません。`, { status: 400 });
    }
    
    // --- 複数テキストのAPIリクエストを並行して実行 ---
    const options = { style_name, style_strength };
    
    // Promise.all を使って、すべてのAPIリクエストが完了するのを待つ
    const results = await Promise.all(
        texts.map(text => synthesizeSingleText(text, targetUuid, apiKey, options))
    );

    // すべての結果を配列としてフロントエンドに返す
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
        // JSONパースエラーなど、handleRequestより前の段階で発生するエラーを捕捉
        return new Response(`サーバー内部で予期せぬエラーが発生しました: ${e.message}`, { status: 500 });
    }
}
