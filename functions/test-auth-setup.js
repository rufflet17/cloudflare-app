// joseとbcryptjsをインポートしてみる
import { SignJWT } from 'jose';
import bcrypt from 'bcryptjs';

// onRequest関数をエクスポート
export async function onRequest(context) {
  const results = {};
  let statusCode = 200;

  // 1. joseのテスト
  try {
    // テスト用の秘密鍵（本来はenvから取得する）
    const secret = new TextEncoder().encode(
      'super-secret-key-for-testing-only'
    );
    // 簡単なJWTを生成してみる
    const jwt = await new SignJWT({ 'urn:example:claim': true })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('urn:example:issuer')
      .setAudience('urn:example:audience')
      .setExpirationTime('2h')
      .sign(secret);

    results.jose_test = 'OK';
    results.generated_jwt_sample = jwt.substring(0, 30) + '...'; // 長すぎるので一部だけ表示
  } catch (e) {
    results.jose_test = 'FAILED';
    results.jose_error = e.message;
    statusCode = 500;
  }

  // 2. bcryptjsのテスト
  try {
    // 簡単なパスワードをハッシュ化してみる
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash('my-test-password', salt);
    // ハッシュ化が成功したかを確認
    const isMatch = await bcrypt.compare('my-test-password', hash);

    results.bcryptjs_test = 'OK';
    results.bcryptjs_hash_sample = hash.substring(0, 30) + '...'; // ハッシュの一部
    results.bcryptjs_compare_result = isMatch; // trueになるはず
  } catch (e) {
    results.bcryptjs_test = 'FAILED';
    results.bcryptjs_error = e.message;
    statusCode = 500;
  }

  // 結果をJSONで返す
  return new Response(JSON.stringify(results, null, 2), {
    status: statusCode,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}