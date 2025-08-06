// functions/synthesize.js

const AUDIO_CONFIGS = {
    mp3: { format: 'mp3', contentType: 'audio/mpeg' },
    wav: { format: 'wav', contentType: 'audio/wav' },
    flac: { format: 'flac', contentType: 'audio/flac' },
    opus: { format: 'opus', contentType: 'audio/opus' },
};
const SUPPORTED_FORMATS = Object.keys(AUDIO_CONFIGS);

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

async function synthesizeSingleText(text, modelUuid, apiKey, options, audioConfig) {
    const { style_id, style_strength } = options;
    
    // Aivis APIのエンドポイント
    const aivisApiUrl = 'https://api.aivis-project.com/v1/tts/synthesize';

    // APIに送信するペイロード
    const requestPayload = {
        text: text,
        model_uuid: modelUuid,
        style_id: Number(style_id),
        // AIVIS APIの仕様に合わせてキーを 'output_format' に修正
        output_format: audioConfig.format
        // 注: style_strength はAPI仕様にないため、必要に応じて 'speaking_rate' などにマッピングしてください
        // speaking_rate: style_strength
    };
    
    try {
        // Aivis APIへのリクエスト
        const aivisResponse = await fetch(aivisApiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestPayload)
        });

        // APIからのエラーレスポンスを処理
        if (!aivisResponse.ok) {
            const errorText = await aivisResponse.text();
            return {
                status: 'error',
                text: text,
                reason: `APIエラー (${aivisResponse.status}): ${errorText}`
            };
        }

        // 実際にAPIが返した音声データのContent-Typeを取得
        const actualContentType = aivisResponse.headers.get('Content-Type');
        const audioArrayBuffer = await aivisResponse.arrayBuffer();
        const audioBase64 = arrayBufferToBase64(audioArrayBuffer);
        
        // 成功時のレスポンスを組み立てる
        return {
            status: 'success',
            text: text,
            audio_base_64: audioBase64,
            content_type: actualContentType // 実際のContent-Typeを返す
        };

    } catch (e) {
        // ネットワークエラーなどを処理
        return {
            status: 'error',
            text: text,
            reason: `リクエスト処理中にエラーが発生: ${e.message}`
        };
    }
}

async function handleRequest(context) {
    const { env } = context;
    const body = await context.request.json();
    
    const { model_id, texts, style_id, style_strength, format = 'mp3' } = body;

    // 入力値のバリデーション
    if (!texts || !Array.isArray(texts) || texts.length === 0) {
        return new Response("リクエストボディに 'texts' (配列) が必要です。", { status: 400 });
    }
    if (model_id === undefined || model_id === null) {
        return new Response("リクエストボディに 'model_id' が必要です。", { status: 400 });
    }
    
    const audioConfig = AUDIO_CONFIGS[format];
    if (!audioConfig) {
        return new Response(`Unsupported format: ${format}. Supported formats are: ${SUPPORTED_FORMATS.join(', ')}`, { status: 400 });
    }
    
    // 環境変数からUUIDとAPIキーを取得
    const targetModelUuid = env[`MODEL_UUID_${model_id}`];
    const apiKey = env.API_KEY;

    if (!apiKey) {
        return new Response("サーバー側の環境変数エラー: API_KEYが設定されていません。", { status: 500 });
    }
    if (!targetModelUuid) {
        return new Response(`サーバーエラー: モデルID ${model_id} のUUIDが見つかりません。`, { status: 400 });
    }
    
    const options = { style_id, style_strength };
    
    // 複数のテキストを並列で処理
    const results = await Promise.all(
        texts.map(text => synthesizeSingleText(text, targetModelUuid, apiKey, options, audioConfig))
    );

    // 結果をJSON形式で返す
    return new Response(JSON.stringify(results), {
        headers: { 'Content-Type': 'application/json' }
    });
}

export async function onRequest(context) {
    // CORS プリフライトリクエストの処理
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
        // CORSヘッダーを追加
        response.headers.set('Access-Control-Allow-Origin', '*');
        return response;
    } catch (e) {
        const errorResponse = new Response(`サーバー内部で予期せぬエラーが発生しました: ${e.message}`, { status: 500 });
        errorResponse.headers.set('Access-Control-Allow-Origin', '*');
        return errorResponse;
    }
}