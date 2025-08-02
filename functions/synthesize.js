// functions/synthesize.js

const API_URL = "https://api.aivis-project.com/v1/tts/synthesize";

// サーバーサイドの定数
const MAX_TEXT_LENGTH = 1000; // 1リクエストあたりの最大文字数 (50文字x10行 + α)

export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return new Response("POSTメソッドを使用してください", { status: 405 });
  }

  try {
    const clientData = await context.request.json();
    
    // ★★★★★ サーバーサイドでの入力値バリデーション ★★★★★
    if (!clientData.text || typeof clientData.text !== 'string' || clientData.text.trim() === '') {
        return new Response("テキストが空です。", { status: 400 });
    }
    if (clientData.text.length > MAX_TEXT_LENGTH) {
        return new Response(`テキストが長すぎます。最大${MAX_TEXT_LENGTH}文字までです。`, { status: 400 });
    }
    
    // 環境変数からAPIキーとモデルUUIDを取得
    const API_KEY = context.env.API_KEY;
    const MODEL_UUID = context.env.MODEL_UUID;

    if (!API_KEY || !MODEL_UUID) {
      return new Response("サーバー側でAPIキーまたはモデルUUIDが設定されていません。", { status: 500 });
    }

    // Aivis APIに送るためのペイロードを作成
    const payload = {
      model_uuid: MODEL_UUID,
      text: clientData.text,
      use_ssml: false,
      output_format: clientData.output_format || "opus",
      language: "ja",
    };

    if (clientData.style_name) {
      payload.style_name = clientData.style_name;
      if (clientData.style_strength !== null && clientData.style_strength !== undefined) {
        payload.style_strength = parseFloat(clientData.style_strength);
      }
    }

    // Aivis APIにリクエストを送信
    const aivisResponse = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!aivisResponse.ok) {
      const errorText = await aivisResponse.text();
      return new Response(`Aivis APIエラー: ${errorText}`, { status: aivisResponse.status });
    }
    
    // Aivis APIからの音声データをクライアントに返す
    const headers = new Headers();
    headers.set('Content-Type', aivisResponse.headers.get('Content-Type'));

    return new Response(aivisResponse.body, {
      status: aivisResponse.status,
      headers: headers
    });

  } catch (e) {
    // JSONパースエラーなどもここでキャッチ
    if (e instanceof SyntaxError) {
      return new Response("無効なリクエスト形式です。", { status: 400 });
    }
    return new Response(`サーバー内部エラー: ${e.message}`, { status: 500 });
  }
}
