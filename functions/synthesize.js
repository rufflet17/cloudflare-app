// functions/synthesize.js

/**
 * Aivis APIに単一の音声合成リクエストを送信するヘルパー関数
 * (この関数はAPI仕様に合わせるため、今回の修正では使用しませんが、今後のために残しておきます)
 */
async function synthesizeSingleText(text, model_uuid, apiKey, options) {
    const { style_name, style_strength } = options;
    const aivisApiUrl = "https://api.aivis-project.com/v1/text2speech";

    // ★★★ 修正点: `speaker_uuid` を `model_uuid` に変更 ★★★
    const requestPayload = {
        text: text,
        model_uuid: model_uuid, // パラメータ名をAPIの要求に合わせて変更
    };
    
    if (style_name && style_name !== "取得失敗") { // "取得失敗" のような無効な値は送らない
        requestPayload.style_name = style_name;
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
            return {
                status: 'error', text: text,
                reason: `APIエラー (${aivisResponse.status}): ${errorText}`
            };
        }
        const aivisData = await aivisResponse.json();
        return {
            status: 'success', text: aivisData.text,
            audio_base64: aivisData.audio_base64,
            content_type: aivisData.content_type || 'audio/opus'
        };

    } catch (e) {
        return { status: 'error', text: text, reason: `リクエスト処理エラー: ${e.message}` };
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
    
    // 変数名を明確にする (targetUuid -> targetModelUuid)
    const targetModelUuid = env[`MODEL_UUID_${model_id}`];
    const apiKey = env.API_KEY;

    if (!apiKey) {
        return new Response("サーバー環境変数エラー: API_KEY未設定", { status: 500 });
    }
    if (!targetModelUuid) {
        return new Response(`サーバーエラー: モデルID ${model_id} のUUIDが見つかりません。`, { status: 400 });
    }
    
    // --- 複数テキストのAPIリクエストを並行して実行 ---
    const options = { style_name, style_strength };
    
    const results = await Promise.all(
        // ★★★ 修正点: targetModelUuid を synthesizeSingleText に渡す ★★★
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
        return new Response(`サーバー内部エラー: ${e.message}`, { status: 500 });
    }
}
