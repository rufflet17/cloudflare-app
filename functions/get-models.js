// functions/get-models.js

export async function onRequest(context) {
  const { env } = context;
  const modelCount = parseInt(env.MODEL_COUNT, 10);

  if (isNaN(modelCount) || modelCount <= 0) {
    return new Response("環境変数 'MODEL_COUNT' が未設定または無効な値です。", { status: 500 });
  }

  const models = [];
  for (let i = 0; i < modelCount; i++) {
    // ★★★ 修正点: MODEL_UUIDのみを読み込む ★★★
    const uuid = env[`MODEL_UUID_${i}`];

    // UUIDが存在する場合のみリストに追加
    if (uuid) {
      models.push({
        id: i, // 0から始まるID
        // ★★★ 修正点: モデル名を自動で生成する ★★★
        name: `モデル ${i + 1}`, // 例: 「モデル 1」「モデル 2」
      });
    } else {
      console.warn(`モデルID ${i} の環境変数 (MODEL_UUID_${i}) が不足しているため、スキップされました。`);
    }
  }

  return new Response(JSON.stringify(models), {
    headers: { 'Content-Type': 'application/json' },
  });
}
