// functions/synthesize.js

// ★★★★★ 設定はここを書き換えるだけ ★★★★★
const AUDIO_CONFIG = {
    format: 'wav',         // Aivis APIにリクエストするフォーマット名
    contentType: 'audio/wav', // HTTPレスポンスやBlobで使うContent-Type
    extension: 'wav'         // ダウンロード時のファイル拡張子
};
// 例: MP3に変更する場合
/*
const AUDIO_CONFIG = {
    format: 'mp3',
    contentType: 'audio/mpeg',
    extension: 'mp3'
};
*/
// ★★★★★★★★★★★★★★★★★★★★★★★★★★★

/**
 * ArrayBufferをBase64文字列に変換するヘルパー関数
 */
function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Aivis APIに単一の音声合成リクエストを送信するヘルパー関数
 */
async function synthesizeSingleText(text, modelUuid, apiKey, options) {
    const { style_id, style_strength } = options;
    
    // 設定オブジェクトからAPIリクエストURLを動的に生成
    const aivisApiUrl = `https://api.aivis-project.com/v1/tts/synthesize?format=${AUDIO_CONFIG.format}`;

    const requestPayload = {
        text: text,
        model_uuid: modelUuid,
        style_id: Number(style_id),
        style_strength: style_strength
    };
    
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

        const audioArrayBuffer = await aivisResponse.arrayBuffer();
        const audioBase64 = arrayBufferToBase64(audioArrayBuffer);
        
        return {
            status: 'success',
            text: text,
            audio_base64: audioBase64,
            content_type: AUDIO_CONFIG.contentType // 設定オブジェクトからContent-Typeを使用
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
    const { model_id, texts, style_id, style_strength } = body;

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
    
    const options = { style_id, style_strength };
    
    const results = await Promise.all(
        texts.map(text => synthesizeSingleText(text, targetModelUuid, apiKey, options))
    );

    return new Response(JSON.stringify(results), {
        headers: { 'Content-Type': 'application/json' }
    });
}

/**
 * Cloudflare Functionsのエントリポイント
 */
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