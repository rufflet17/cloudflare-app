// functions/synthesize.js

// --- 設定項目 (ここをCloudflareの環境変数に設定するのがベスト) ---
// ローカルテスト用に直接書くか、本番では環境変数を使います。
// const API_KEY = "XXX";
// const MODEL_UUID = "YYY";

const API_URL = "https://api.aivis-project.com/v1/tts/synthesize";

export async function onRequest(context) {
  // Cloudflare Pagesでは、POSTリクエストの処理はこのように書くのが標準です
  if (context.request.method !== "POST") {
    return new Response("POSTメソッドを使用してください", { status: 405 });
  }

  try {
    // 1. クライアントからのリクエストボディ(JSON)を取得
    const clientData = await context.request.json();
    
    // ★★★★★ 安全な方法: 環境変数からAPIキーを取得 ★★★★★
    // Cloudflareのダッシュボードで `API_KEY` と `MODEL_UUID` を設定してください。
    const API_KEY = context.env.API_KEY;
    const MODEL_UUID = context.env.MODEL_UUID;

    if (!API_KEY || !MODEL_UUID) {
      return new Response("サーバー側でAPIキーまたはモデルUUIDが設定されていません。", { status: 500 });
    }

    // 2. Aivis APIに送るためのペイロードを作成
    const payload = {
      model_uuid: MODEL_UUID,
      text: clientData.text,
      use_ssml: false,
      output_format: clientData.output_format || "opus", // クライアントから指定がなければOpusをデフォルトに
      language: "ja",
    };

    if (clientData.style_name) {
      payload.style_name = clientData.style_name;
      if (clientData.style_strength !== null && clientData.style_strength !== undefined) {
        payload.style_strength = parseFloat(clientData.style_strength);
      }
    }

    // 3. Aivis APIにリクエストを送信
    const aivisResponse = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    // 4. Aivis APIからのレスポンスをチェック
    if (!aivisResponse.ok) {
      // エラーの場合は、Aivisからのエラーメッセージをクライアントに返す
      const errorText = await aivisResponse.text();
      return new Response(`Aivis APIエラー: ${errorText}`, { status: aivisResponse.status });
    }

    // 5. Aivis APIからの音声データをクライアントにストリーミングで返す
    //    Content-Typeヘッダーなどをそのまま引き継ぐ
    const headers = new Headers();
    headers.set('Content-Type', aivisResponse.headers.get('Content-Type'));

    // ダウンロード用のリクエストかどうかを判定
    if (clientData.download) {
        headers.set('Content-Disposition', 'attachment; filename="aivis_output.opus"');
    }

    return new Response(aivisResponse.body, {
      status: aivisResponse.status,
      headers: headers
    });

  } catch (e) {
    return new Response(`サーバー内部エラー: ${e.message}`, { status: 500 });
  }
}