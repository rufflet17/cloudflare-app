// functions/_api-logic.js
import { Buffer } from 'node:buffer';
import { getAuthUser } from './_auth-helper';

/**
 * 成功時のJSONレスポンスを生成
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * エラー時のJSONレスポンスを生成
 */
function errorResponse(message, status = 500) {
  console.error(message);
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * アップロード処理
 */
export async function handleUpload(context) {
  const { env, request } = context;
  const user = getAuthUser(request);
  if (!user) return errorResponse('認証が必要です。', 401);

  const { audioBase64, contentType, extension, modelName, textContent } = await request.json();
  if (!audioBase64 || !contentType || !extension || !modelName) {
    return errorResponse('必須パラメータが不足しています。', 400);
  }

  const r2Key = `${crypto.randomUUID()}.${extension}`;
  const audioData = Buffer.from(audioBase64, 'base64');

  await env.MY_TTS_R2_BUCKET.put(r2Key, audioData, { httpMetadata: { contentType } });

  const d1_id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await env.MY_D1_DATABASE.prepare(
    `INSERT INTO audios (id, r2_key, user_id, model_name, text_content, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(d1_id, r2Key, user.id, modelName, textContent, createdAt).run();

  return jsonResponse({ key: r2Key });
}

/**
 * 一覧取得処理
 */
export async function handleList(context) {
  const { env, request } = context;
  const user = getAuthUser(request);
  if (!user) return errorResponse('認証が必要です。', 401);

  const { results } = await env.MY_D1_DATABASE.prepare(
    `SELECT id, r2_key, model_name, text_content, created_at FROM audios WHERE user_id = ? ORDER BY created_at DESC`
  ).bind(user.id).all();
  
  return jsonResponse(results);
}

/**
 * ファイル取得処理
 */
export async function handleGet(context) {
  const { env } = context;
  const r2Key = context.params.key.join('/');
  if (!r2Key) return new Response('File key not specified', { status: 400 });

  const object = await env.MY_TTS_R2_BUCKET.get(r2Key);
  if (object === null) return new Response('Object Not Found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  return new Response(object.body, { headers });
}

/**
 * 削除処理
 */
export async function handleDelete(context) {
  const { env, request } = context;
  const r2Key = context.params.key.join('/');
  const user = getAuthUser(request);
  if (!user) return errorResponse('認証が必要です。', 401);

  // ユーザーが所有するファイルか確認（任意だが推奨）
  const { results } = await env.MY_D1_DATABASE.prepare(
      `SELECT id FROM audios WHERE r2_key = ? AND user_id = ?`
  ).bind(r2Key, user.id).all();

  if (results.length === 0) {
      return errorResponse('指定されたファイルを削除する権限がありません。', 403);
  }

  // D1とR2から削除
  await env.MY_D1_DATABASE.prepare('DELETE FROM audios WHERE r2_key = ?').bind(r2Key).run();
  await env.MY_TTS_R2_BUCKET.delete(r2Key);

  return jsonResponse({ message: '削除が完了しました。' });
}