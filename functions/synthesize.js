// functions/synthesize.js (speaker_uuid不要、パラメータ名修正版)

const AUDIO_CONFIGS = {
    mp3: { format: 'mp3', contentType: 'audio/mpeg' },
    wav: { format: 'wav', contentType: 'audio/wav' },
    flac: { format: 'flac', contentType: 'audio/flac' },
    opus: { format: 'opus', contentType: 'audio/opus' },
};

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

// ★★★ ここからが修正箇所 (synthesizeSingleText 関数) ★★★
async function synthesizeSingleText(text, modelUuid, apiKey, options, audioConfig) {
    const { style_id, style_strength, speed, volume } = options;
    
    const aivisApiUrl = 'https://api.aivis-project.com/v1/tts/synthesize';

    // APIに送信するペイロード
    const requestPayload = {
        text: text,
        model_uuid: modelUuid,
        style_id: Number(style_id),
        output_format: audioConfig.format
    };

    // フロントエンドからの値を、APIが要求する正しいパラメータ名にマッピング
    if (speed !== undefined) {
        // 'speed' を 'speaking_rate' に変更
        requestPayload.speaking_rate = Number(speed);
    }
    if (volume !== undefined) {
        // 'volume' はそのまま
        requestPayload.volume = Number(volume);
    }
    if (style_strength !== undefined) {
        // 'style_strength' を 'emotional_intensity' にマッピング
        requestPayload.emotional_intensity = Number(style_strength);
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

        const actualContentType = aivisResponse.headers.get('Content-Type');
        const audioArrayBuffer = await aivisResponse.arrayBuffer();
        const audioBase64 = arrayBufferToBase64(audioArrayBuffer);
        
        return {
            status: 'success',
            text: text,
            audio_base_64: audioBase64,
            content_type: actualContentType
        };

    } catch (e) {
        return {
            status: 'error',
            text: text,
            reason: `リクエスト処理中にエラーが発生: ${e.message}`
        };
    }
}
// ★★★ ここまでが修正箇所 ★★★

async function handleRequest(context) {
    const { env } = context;
    const body = await context.request.json();
    
    const { model_id, texts, style_id, style_strength, format = 'mp3', speed, volume } = body;

    if (!texts || !Array.isArray(texts) || texts.length === 0) {
        return new Response("リクエストボディに 'texts' (配列) が必要です。", { status: 400 });
    }
    if (model_id === undefined || model_id === null) {
        return new Response("リクエストボディに 'model_id' が必要です。", { status: 400 });
    }
    
    const audioConfig = AUDIO_CONFIGS[format];
    if (!audioConfig) {
        return new Response(`Unsupported format: ${format}.`, { status: 400 });
    }
    
    const targetModelUuid = env[`MODEL_UUID_${model_id}`];
    const apiKey = env.API_KEY;

    if (!apiKey) {
        return new Response("サーバー側の環境変数エラー: API_KEYが設定されていません。", { status: 500 });
    }
    if (!targetModelUuid) {
        return new Response(`サーバーエラー: モデルID ${model_id} のUUIDが見つかりません。`, { status: 400 });
    }
    
    const options = { style_id, style_strength, speed, volume };
    
    // synthesizeSingleTextの呼び出しも speakerUuid なしに変更
    const results = await Promise.all(
        texts.map(text => synthesizeSingleText(text, targetModelUuid, apiKey, options, audioConfig))
    );

    return new Response(JSON.stringify(results), {
        headers: { 'Content-Type': 'application/json' }
    });
}

export async function onRequest(context) {
    if (context.request.method === 'OPTIONS') {
        return new Response(null, {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
            },
        });
    }

    if (context.request.method !== "POST") {
        return new Response("POSTメソッドを使用してください", { status: 405 });
    }

    try {
        const response = await handleRequest(context);
        response.headers.set('Access-Control-Allow-Origin', '*');
        return response;
    } catch (e) {
        const errorResponse = new Response(`サーバー内部で予期せぬエラーが発生しました: ${e.message}`, { status: 500 });
        errorResponse.headers.set('Access-Control-Allow-Origin', '*');
        return errorResponse;
    }
}