// functions/get-models.js

export async function onRequest(context) {
  const { env } = context;
  const modelCount = parseInt(env.MODEL_COUNT, 10);

  if (isNaN(modelCount) || modelCount <= 0) {
    return new Response("環境変数 'MODEL_COUNT' が未設定または無効な値です。", { status: 500 });
  }

  const models = [];
  for (let i = 0; i < modelCount; i++) {
    const uuid = env[`MODEL_UUID_${i}`];
    const name = env[`MODEL_NAME_${i}`];

    if (uuid && name) {
      models.push({
        id: i, // 0から始まるID
        name: name,
      });
    } else {
      // 運用上、ログに警告を残しておくとデバッグに便利
      console.warn(`モデルID ${i} の環境変数 (MODEL_UUID_${i} または MODEL_NAME_${i}) が不足しているため、スキップされました。`);
    }
  }

  return new Response(JSON.stringify(models), {
    headers: { 'Content-Type': 'application/json' },
  });
}