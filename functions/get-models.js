// functions/get-models.js

export async function onRequest(context) {
  const { env } = context;
  const models = [];

  // 環境変数オブジェクトのキーをすべて取得
  const envKeys = Object.keys(env);

  // 'MODEL_UUID_'で始まるキーを持つモデルのインデックス（番号）を抽出
  const modelIndices = envKeys
    .map(key => {
      // キーが 'MODEL_UUID_' で始まるかチェック
      if (key.startsWith('MODEL_UUID_')) {
        // 'MODEL_UUID_' の後ろの数字部分を抜き出す
        const indexStr = key.substring('MODEL_UUID_'.length);
        const index = parseInt(indexStr, 10);
        // 数字として正しく解釈できた場合のみ、その数字を返す
        return !isNaN(index) ? index : null;
      }
      return null;
    })
    .filter(index => index !== null); // null（該当しないキー）を除外

  // 抽出したインデックスを小さい順にソートする
  // これにより、UI上のモデルの並び順が番号順に固定される
  modelIndices.sort((a, b) => a - b);

  // ソートされたインデックスを元にモデルリストを作成
  for (const index of modelIndices) {
    // 対応するUUIDが実際に存在することを確認（念のため）
    if (env[`MODEL_UUID_${index}`]) {
      models.push({
        id: index, // 0, 1, 2... というID
        name: `モデル ${index + 1}`, // UI表示名: 「モデル 1」「モデル 2」...
      });
    }
  }

  return new Response(JSON.stringify(models), {
    headers: { 'Content-Type': 'application/json' },
  });
}
