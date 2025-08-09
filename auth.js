// auth.js (セキュリティパスのみを修正したバージョン)

(function() {
    'use strict';

    // =========================================================================
    // ★★★ ユーザー設定 1/2: ご自身のFirebaseプロジェクト設定に書き換えてください ★★★
    // =========================================================================
    const firebaseConfig = {
        apiKey: "AIzaSyCfnWPi16Tt8PQGzb6Qo2ql3yFf2GSGaN8",
        authDomain: "voice-1e03c.firebaseapp.com",
        projectId: "voice-1e03c",
        storageBucket: "voice-1e03c.firebasestorage.app",
        messagingSenderId: "1067746798695",
        appId: "1:1067746798695:web:76bc39f08b51fc512c38c2",
        measurementId: "G-W5TEENZEJ0"
    };

    // =========================================================================
    // ★★★ ユーザー設定 2/2: 認証が必要なWorkerのエンドポイント（パス）を記述 ★★★
    // =========================================================================
    // D1/R2を操作する新しいAPIパスを保護対象にする
    const PROTECTED_API_PATHS = ['/api/audios'];


    // --- これより下は通常、変更不要です ---

    firebase.initializeApp(firebaseConfig);
    const auth = firebase.auth();
    let currentUser = null;

    async function getIdToken() {
        if (!auth.currentUser) return null;
        try {
            return await auth.currentUser.getIdToken(true);
        } catch (error) {
            console.error("IDトークンの取得に失敗:", error);
            return null;
        }
    }

    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const url = args[0] instanceof Request ? args[0].url : String(args[0]);
        const options = args[1] || {};
        const isProtected = typeof url === 'string' && PROTECTED_API_PATHS.some(path => url.startsWith(path));

        if (isProtected) {
            if (!currentUser) {
                console.warn('保護されたAPIへのリクエストがブロックされました: 未ログイン');
                return Promise.resolve(new Response(JSON.stringify({ error: 'Authentication required.' }),{ status: 401, statusText: 'Unauthorized' }));
            }
            const token = await getIdToken();
            if (!token) {
                 console.error('保護されたAPIへのリクエストがブロックされました: トークン取得失敗');
                return Promise.resolve(new Response(JSON.stringify({ error: 'Failed to retrieve auth token.' }), { status: 401, statusText: 'Unauthorized' }));
            }
            options.headers = { ...options.headers, 'Authorization': `Bearer ${token}` };
            args[1] = options;
        }
        return originalFetch.apply(this, args);
    };

    async function handleEditUsername() {
        if (!currentUser) return;

        const currentName = currentUser.displayName || '';
        const newName = prompt("新しい表示名を入力してください（20文字以内）:", currentName);

        if (newName === null) { return; }
        const trimmedName = newName.trim();
        if (trimmedName === "") { alert("表示名は空にできません。"); return; }
        if (trimmedName.length > 20) { alert("表示名は20文字以内で入力してください。"); return; }

        try {
            await currentUser.updateProfile({ displayName: trimmedName });
            document.getElementById('user-info').textContent = trimmedName;
            document.getElementById('user-info').title = trimmedName;
            alert("表示名を更新しました。");
        } catch (error)
        {
            console.error("表示名の更新に失敗しました:", error);
            alert("エラーが発生しました。表示名を更新できませんでした。");
        }
    }

    function updateUIForAuthState(user) {
        const loginBtn = document.getElementById('login-btn');
        const logoutBtn = document.getElementById('logout-btn');
        const userDisplayWrapper = document.getElementById('user-display-wrapper');
        const userInfo = document.getElementById('user-info');
        const editUsernameBtn = document.getElementById('edit-username-btn');

        const r2GalleryTab = document.querySelector('.tab-button[data-tab="r2-gallery"]');
        const r2GalleryWrapper = document.getElementById('r2-gallery-wrapper');
        const saveToR2Btn = document.getElementById('save-to-r2-btn');
        const savePreviewToR2Btn = document.getElementById('save-preview-to-r2-btn');

        currentUser = user;

        if (user) {
            loginBtn.style.display = 'none';
            logoutBtn.style.display = 'block';
            userDisplayWrapper.style.display = 'flex';
            
            const displayName = user.displayName || user.email;
            userInfo.textContent = displayName;
            userInfo.title = displayName;
            editUsernameBtn.onclick = handleEditUsername;

            r2GalleryTab.classList.remove('locked-feature');
            r2GalleryWrapper.classList.remove('locked-feature');
            if (saveToR2Btn) saveToR2Btn.disabled = false;
            if (savePreviewToR2Btn) savePreviewToR2Btn.disabled = false;

            if (typeof refreshR2Gallery === 'function') { refreshR2Gallery(); }
        } else {
            loginBtn.style.display = 'block';
            logoutBtn.style.display = 'none';
            userDisplayWrapper.style.display = 'none';

            r2GalleryTab.classList.add('locked-feature');
            r2GalleryWrapper.classList.add('locked-feature');
            document.getElementById('r2-gallery-container').innerHTML = '<p>この機能を利用するにはログインが必要です。</p>';
            if (saveToR2Btn) saveToR2Btn.disabled = true;
            if (savePreviewToR2Btn) savePreviewToR2Btn.disabled = true;
            
            if (r2GalleryTab.classList.contains('active')) {
                document.querySelector('.tab-button[data-tab="tts"]').click();
            }
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        // ログインボタンの処理
        document.getElementById('login-btn').addEventListener('click', () => {
            const provider = new firebase.auth.GoogleAuthProvider();
            
            auth.signInWithPopup(provider).catch(error => {
                // ユーザー起因のキャンセルはアラートを表示しない
                if (error.code === 'auth/popup-closed-by-user' || error.code === 'auth/cancelled-popup-request') {
                    console.log(`ログインがキャンセルされました: ${error.code}`);
                } else {
                    // それ以外の本当のエラーの場合はアラートを表示する
                    console.error("Googleログインエラー:", error);
                    alert(`ログインに失敗しました: ${error.message}`);
                }
            });
        });

        document.getElementById('logout-btn').addEventListener('click', () => {
            auth.signOut();
        });

        auth.onAuthStateChanged(updateUIForAuthState);
    });

})();