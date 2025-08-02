// functions/synthesize.js

// ★★★★★ ここからが修正点 ★★★★★
/**
 * ArrayBufferをBase64文字列に変換するヘルパー関数
 * Bufferオブジェクトが使えないCloudflareの環境で動作します。
 * @param {ArrayBuffer} buffer - 変換するArrayBuffer
 * @returns {string} Base64エンコードされた文字列
 */
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // btoaはWeb標準のAPIで、Cloudflare Workers/Functionsで利用可能です
  return btoa(binary);
}
// ★★★★★ ここまでが修正点 ★★★★★


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

        const audioArrayBuffer = await aivisResponse.arrayBuffer();
        
        // ★★★★★ ここからが修正点 ★★★★★
        // Buffer.from(...) の代わりに、上で定義したヘルパー関数を使用します。
        const audioBase64 = arrayBufferToBase64(audioArrayBuffer);
        // ★★★★★ ここまでが修正点 ★★★★★

        const contentType = aivisResponse.headers.get('Content-Type') || 'audio/mpeg';

        return {
            status: 'success',
            text: text,
            audio_base64: audioBase64,
            content_type: contentType
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
 * メインのリクエストハンドラー (変更なし)
 */
async function handleRequest(context) {
    const { env } = context;
    const body = await context.request.json();
    const { model_id, texts, style_name, style_strength } = body;

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
