// functions/synthesize.js

/**
 * Aivis API v1/tts/synthesize に単一の音声合成リクエストを送信するヘルパー関数
 */
async function synthesizeSingleText(text, modelUuid, apiKey, options) {
    const { style_name, style_strength } = options;
    const aivisApiUrl = "https://api.aivis-project.com/v1/tts/synthesize";

    const requestPayload = {
        text: text,
        model_uuid: modelUuid,
    };
    
    if (style_name && style_name !== "取得失敗") {
        requestPayload.style_name = style_name;
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

        // ★★★★★ ここからが最重要修正点 ★★★★★

        // 1. APIからの応答をJSONではなく、生のバイナリデータ(ArrayBuffer)として取得します。
        const audioArrayBuffer = await aivisResponse.arrayBuffer();

        // 2. 取得したバイナリデータをBase64形式の文字列に変換します。
        // Cloudflare WorkersではBufferが利用できます。
        const audioBase64 = Buffer.from(audioArrayBuffer).toString('base64');

        // 3. レスポンスヘッダーからContent-Typeを取得します。
        const contentType = aivisResponse.headers.get('Content-Type') || 'audio/mpeg'; // MP3の場合のデフォルト

        // 4. フロントエンドが期待する形式の成功オブジェクトを組み立てて返します。
        return {
            status: 'success',
            text: text, // APIはテキストを返さないので、リクエストしたテキストを使用
            audio_base64: audioBase64,
            content_type: contentType
        };
        // ★★★★★ ここまでが最重要修正点 ★★★★★

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

    // --- バリデーション (変更なし) ---
    if (!texts || !Array.isArray(texts) || texts.length === 0) {
        return new Response("リクエストボディに 'texts' (配列) が必要です。", { status: 400 });
    }
    if (model_id === undefined || model_id === null) {
        return new Response("リクエストボディに 'model_id' が必要です。", { status: 400 });
    }
    
    const targetModelUuid = env[`MODEL_UUID_${model_id}`];
    const apiKey = env.API_KEY;

    if (!apiKey) {
        return new Response("サーバー側の環境変数エラー: API_KEYが設定されていません。", { status: 500 });
    }
    if (!targetModelUuid) {
        return new Response(`サーバーエラー: モデルID ${model_id} のUUIDが見つかりません。`, { status: 400 });
    }
    
    // --- 複数テキストのAPIリクエストを並行して実行 (変更なし) ---
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
