// functions/get-models.js

export async function onRequest(context) {
  const { env } = context;
  const models = [];

  // 環境変数オブジェクトのキーをすべて取得
  const envKeys = Object.keys(env);

  // 'MODEL_UUID_'で始まるキーを持つモデルのインデックス（番号）を抽出
  const modelIndices = envKeys
    .map(key => {
      if (key.startsWith('MODEL_UUID_')) {
        const indexStr = key.substring('MODEL_UUID_'.length);
        const index = parseInt(indexStr, 10);
        return !isNaN(index) ? index : null;
      }
      return null;
    })
    .filter(index => index !== null);

  // 抽出したインデックスを小さい順にソートする
  modelIndices.sort((a, b) => a - b);

  // ソートされたインデックスを元にモデルリストを作成
  for (const index of modelIndices) {
    if (env[`MODEL_UUID_${index}`]) {
      models.push({
        id: index, // 0, 1, 2... という内部ID
        // ★★★ 修正点: `index + 1` から `index` に変更 ★★★
        name: `モデル ${index}`, // UI表示名: 「モデル 0」「モデル 1」...
      });
    }
  }

  return new Response(JSON.stringify(models), {
    headers: { 'Content-Type': 'application/json' },
  });
}
