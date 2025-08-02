// functions/synthesize.js

const API_URL = "https://api.aivis-project.com/v1/tts/synthesize";
const MAX_LINES_PER_REQUEST = 10;

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function synthesizeSingleText(text, commonPayload) {
  const payload = { ...commonPayload, text };
  const aivisResponse = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${commonPayload.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!aivisResponse.ok) {
    const errorText = await aivisResponse.text();
    throw new Error(`Aivis APIエラー: ${errorText}`);
  }
  const audioArrayBuffer = await aivisResponse.arrayBuffer();
  const contentType = aivisResponse.headers.get('Content-Type');
  return {
    text: text,
    status: 'success',
    audio_base64: arrayBufferToBase64(audioArrayBuffer),
    content_type: contentType,
  };
}

export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return new Response("POSTメソッドを使用してください", { status: 405 });
  }
  try {
    const clientData = await context.request.json();
    if (!Array.isArray(clientData.texts) || clientData.texts.length === 0) {
      return new Response("texts (配列) が必要です。", { status: 400 });
    }
    if (clientData.texts.length > MAX_LINES_PER_REQUEST) {
      return new Response(`一度に処理できるのは最大${MAX_LINES_PER_REQUEST}行までです。`, { status: 400 });
    }
    const { API_KEY, MODEL_UUID } = context.env;
    if (!API_KEY || !MODEL_UUID) {
      return new Response("サーバー側でAPIキーまたはモデルUUIDが設定されていません。", { status: 500 });
    }
    const commonPayload = {
      model_uuid: MODEL_UUID,
      apiKey: API_KEY,
      use_ssml: false,
      output_format: "opus",
      language: "ja",
    };
    if (clientData.style_name) {
      commonPayload.style_name = clientData.style_name;
      commonPayload.style_strength = parseFloat(clientData.style_strength);
    }
    const promises = clientData.texts.map(text =>
      synthesizeSingleText(text, commonPayload)
        .catch(e => ({ text: text, status: 'error', reason: e.message }))
    );
    const results = await Promise.all(promises);
    return new Response(JSON.stringify(results), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(`サーバー内部エラー: ${e.message}`, { status: 500 });
  }
}
