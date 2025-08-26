// このファイルはUIロジック、状態管理、イベントリスナーを担当します。
// サーバー通信は行わず、index.htmlで定義された `window.api` を介して行います。
(function() {
    'use strict';

    // --- グローバル定数、DOM要素、状態管理変数 ---
    const SHOW_ADVANCED_FORMATS = true;
    
    // DOM Elements
    let modelSelectTTS, modelSelectBG, formatSelect, generateBtn, generatePreviewBtn, textInput, styleIdInput, styleStrengthInput, strengthValueSpan, statusDiv, resultsContainer, combinedResultContainer, combinedAudioPlayer, downloadCombinedBtn, combinedPreviewArea, combinedPreviewPlayer, downloadCombinedPreviewBtn, containerWrapper, bodyElement, containerHeader, uiWidthSlider, uiWidthInput, uiOpacitySlider, uiOpacityInput, displayNameInput, saveDisplayNameBtn, galleryContainer, tabButtons, tabContents, resetUiBtn, resetAllBgsBtn, uploadImageBtn, imageUploadInput, exportAllSettingsBtn, bgAdjustToggle, bgFadeOverlay, adjustModeControls, revertBgChangesBtn, applyBgChangesBtn, resultsPlaceholder, addFirstCardBtn, saveToR2Btn, r2GalleryContainer, refreshR2GalleryBtn, savePreviewToR2Btn, r2SearchModelSelect, r2SearchTextInput, r2FilterMineToggle, r2FilterStatus, r2PaginationControls, r2PrevPageBtn, r2NextPageBtn, r2PageInfo, loginBtn, logoutBtn, editUsernameBtn;
    
    // State Management
    let appState = {}, resultStates = {}, originalModels = [];
    let currentCombinedAudioBlob = null, currentCombinedAudioInfo = { text: '', filename: '' };
    let currentPreviewAudioBlob = null, currentPreviewAudioInfo = { text: '', filename: '' };
    const defaultUiSettings = { width: 700, posX: (window.innerWidth - 700) / 2, posY: 32, opacity: 1.0 };
    let isAdjustMode = false, tempBgSettings = { pixelX: 0, pixelY: 0, scale: 1.0 };
    let isDraggingBg = false, isPanning = false, isPinching = false, lastPinchDist = 0;
    let dragStart = { mouseX: 0, mouseY: 0, pixelX: 0, pixelY: 0 };
    let panStart = { touchX: 0, touchY: 0, pixelX: 0, pixelY: 0 };
    let animationFrameId = null;
    const R2_ITEMS_PER_PAGE = 50;
    let r2GalleryState = { currentPage: 1, filter: 'all', modelId: '', searchText: '', userId: '', isLoading: false, hasNextPage: false };
    let currentUser = null, userProfile = null;
    let db;

    // --- IndexedDB 定数 & ヘルパー関数 ---
    const DB_NAME = 'TestPostsDB', DB_VERSION = 2, STORE_NAME = 'test_posts', SETTINGS_STORE_NAME = 'settings';

    function initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onerror = (event) => reject("IndexedDBのオープンに失敗しました: " + event.target.errorCode);
            request.onsuccess = (event) => { db = event.target.result; resolve(db); };
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) { const store = db.createObjectStore(STORE_NAME, { keyPath: 'r2_key' }); store.createIndex('created_at', 'created_at', { unique: false }); }
                if (!db.objectStoreNames.contains(SETTINGS_STORE_NAME)) { db.createObjectStore(SETTINGS_STORE_NAME, { keyPath: 'key' }); }
            };
        });
    }

    function addTestPost(post) {
        return new Promise((resolve, reject) => {
            if (!db) return reject("DBが初期化されていません。");
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.add(post);
            request.onsuccess = () => resolve();
            request.onerror = (event) => reject("投稿の追加に失敗しました: " + event.target.error);
        });
    }

    function getAllTestPosts() {
        return new Promise((resolve, reject) => {
            if (!db) return reject("DBが初期化されていません。");
            const transaction = db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.getAll();
            request.onsuccess = (event) => resolve(event.target.result);
            request.onerror = (event) => reject("投稿の取得に失敗しました: " + event.target.error);
        });
    }
    
    function deleteTestPost(key) {
        return new Promise((resolve, reject) => {
            if (!db) return reject("DBが初期化されていません。");
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.delete(key);
            request.onsuccess = () => resolve();
            request.onerror = (event) => reject("投稿の削除に失敗しました: " + event.target.error);
        });
    }
    
    async function enforceLimit() {
        if (!db) return;
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('created_at');
        const countRequest = index.count();

        countRequest.onsuccess = () => {
            const count = countRequest.result;
            if (count > 50) {
                const itemsToDelete = count - 50;
                const cursorRequest = index.openCursor(null, 'next');
                let deletedCount = 0;
                cursorRequest.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor && deletedCount < itemsToDelete) {
                        cursor.delete();
                        deletedCount++;
                        cursor.continue();
                    }
                };
            }
        };
    }

    function getAllSettings() {
        return new Promise((resolve, reject) => {
            if (!db) return reject("DBが初期化されていません。");
            const transaction = db.transaction([SETTINGS_STORE_NAME], 'readonly');
            const store = transaction.objectStore(SETTINGS_STORE_NAME);
            const request = store.getAll();
            request.onsuccess = (event) => {
                const settingsArray = event.target.result;
                const settingsObject = {};
                settingsArray.forEach(item => { settingsObject[item.key] = item.value; });
                resolve(settingsObject);
            };
            request.onerror = (event) => reject("設定の取得に失敗しました: " + event.target.error);
        });
    }

    function saveAllSettings(state) {
        return new Promise((resolve, reject) => {
            if (!db) return reject("DBが初期化されていません。");
            const transaction = db.transaction([SETTINGS_STORE_NAME], 'readwrite');
            const store = transaction.objectStore(SETTINGS_STORE_NAME);
            const keys = Object.keys(state);
            if (keys.length === 0) { resolve(); return; }
            keys.forEach(key => { store.put({ key: key, value: state[key] }); });
            transaction.oncomplete = () => resolve();
            transaction.onerror = (event) => reject("トランザクションエラー: " + event.target.error);
        });
    }

    function clearSettingsStore() {
        return new Promise((resolve, reject) => {
            if (!db) return reject("DBが初期化されていません。");
            const transaction = db.transaction([SETTINGS_STORE_NAME], 'readwrite');
            const store = transaction.objectStore(SETTINGS_STORE_NAME);
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = (event) => reject("設定ストアのクリアに失敗しました: " + event.target.error);
        });
    }

    // --- 1. アプリケーションの基本機能 (UI, データ管理) ---
    const loadState = async () => {
        try { const savedState = await getAllSettings(); appState = savedState || {}; } 
        catch (error) { console.error("IndexedDBからの設定読み込みに失敗:", error); appState = {}; }
        appState.uiSettings = { ...defaultUiSettings, ...(appState.uiSettings || {}) };
    };
    const saveState = () => saveAllSettings(appState).catch(error => { console.error("IndexedDBへの設定保存に失敗:", error); setStatus("設定の保存に失敗しました。", true); });
    const getModelData = (modelId) => { if (!appState[modelId]) { const modelName = originalModels.find(m => m.id === modelId)?.name || modelId; appState[modelId] = { displayName: modelName, images: [], activeImageId: null }; } return appState[modelId]; };
    const getActiveImage = (modelId) => modelId ? getModelData(modelId).images.find(img => img.id === getModelData(modelId).activeImageId) : null;
    const getCurrentModelId = () => modelSelectTTS.value;
    const setStatus = (message, isError = false) => { statusDiv.textContent = message; statusDiv.className = isError ? 'status-error' : 'status-info'; };

    const updateSelectOptions = () => {
        [modelSelectTTS, modelSelectBG].forEach(sel => Array.from(sel.options).forEach(opt => { if(opt.value) opt.textContent = getModelData(opt.value).displayName; }));
        const r2Models = [...new Set(originalModels.map(m => m.id))];
        const currentR2Model = r2SearchModelSelect.value;
        r2SearchModelSelect.innerHTML = '<option value="">すべてのモデル</option>';
        r2Models.forEach(id => {
            const displayName = getModelData(id).displayName || id;
            const option = document.createElement('option');
            option.value = id; option.textContent = displayName; r2SearchModelSelect.appendChild(option);
        });
        r2SearchModelSelect.value = currentR2Model;
    };

    const applyUiSettings = () => {
        const { width, posX, posY, opacity } = appState.uiSettings;
        containerWrapper.style.maxWidth = `${width}px`; containerWrapper.style.left = `${posX}px`;
        containerWrapper.style.top = `${posY}px`; containerWrapper.style.opacity = opacity;
        uiWidthSlider.value = width; uiWidthInput.value = width;
        uiOpacitySlider.value = opacity; uiOpacityInput.value = opacity;
    };

    const applyBackground = (image) => {
        if (image && image.dataUrl) {
            bodyElement.style.backgroundImage = `url(${image.dataUrl})`;
            bodyElement.style.backgroundSize = `${100 * (image.scale || 1.0)}%`;
            bodyElement.style.backgroundPosition = `${image.pixelX || 0}px ${image.pixelY || 0}px`;
        } else { bodyElement.style.backgroundImage = 'none'; }
    };

    const renderGallery = (modelId) => {
        const modelData = getModelData(modelId); galleryContainer.innerHTML = '';
        const noBgItem = document.createElement('div');
        noBgItem.className = 'gallery-item'; noBgItem.dataset.action = 'clear-bg';
        if (modelData.activeImageId === null) { noBgItem.classList.add('active-bg'); }
        noBgItem.innerHTML = `<div style="height: 80px; background-color: #f0f2f5; border: 2px dashed #ccc; box-sizing: border-box; border-radius: 4px; cursor: pointer;"></div><p class="gallery-item-name">背景なし</p>`;
        galleryContainer.appendChild(noBgItem);
        modelData.images.forEach(img => {
            const item = document.createElement('div'); item.className = 'gallery-item';
            if (img.id === modelData.activeImageId) item.classList.add('active-bg');
            item.dataset.imageId = img.id;
            item.innerHTML = `<button class="btn-delete-img" title="この画像を削除">×</button><img src="${img.dataUrl}" alt="thumbnail"><p class="gallery-item-name">${img.name}</p>`;
            galleryContainer.appendChild(item);
        });
    };

    const renderUIForSelectedModel = () => {
        const modelId = getCurrentModelId(); if (!modelId) return;
        displayNameInput.value = getModelData(modelId).displayName;
        const activeImage = getActiveImage(modelId); applyBackground(activeImage); renderGallery(modelId);
        if (isAdjustMode) { endBgAdjustMode({ revert: true }); }
        document.getElementById('image-adjust-panel').style.display = activeImage ? 'block' : 'none';
    };

    const createImageName = (image) => `${image.id}_${Math.round(image.pixelX)}_${Math.round(image.pixelY)}_${image.scale.toFixed(2)}.${image.extension}`;

    const handleFile = (file) => {
        if (file.type.startsWith('image/')) { importImage(file); } 
        else if (file.type === 'application/zip' || file.type === 'application/x-zip-compressed' || file.name.endsWith('.zip')) { importZip(file); } 
        else { setStatus('画像またはZIPファイルを選択してください。', true); }
    };

    const importImage = (file) => {
        const modelId = getCurrentModelId();
        if (!modelId) { setStatus('先に音声モデルを選択してください。', true); return; }
        const reader = new FileReader();
        reader.onload = (event) => {
            const modelData = getModelData(modelId);
            const w = window.innerWidth, h = window.innerHeight;
            const newImage = { id: Date.now(), dataUrl: event.target.result, pixelX: (w - (w * 1.0)) / 2, pixelY: (h - (h * 1.0)) / 2, scale: 1.0, extension: file.name.split('.').pop() || 'png' };
            newImage.name = createImageName(newImage);
            modelData.images.push(newImage); modelData.activeImageId = newImage.id;
            saveState(); performFadeSwitch(() => renderUIForSelectedModel());
            setStatus(`画像「${newImage.name}」を背景に設定しました。`);
        };
        reader.readAsDataURL(file);
    };

    const exportAllSettings = async () => {
        setStatus('設定をエクスポート中...');
        try {
            const zip = new JSZip(); const stateToExport = JSON.parse(JSON.stringify(appState));
            for (const modelId in stateToExport) {
                if (modelId === 'uiSettings' || !stateToExport[modelId].images) continue;
                for (const image of stateToExport[modelId].images) {
                    if (image.dataUrl) {
                        const match = image.dataUrl.match(/data:(image\/\w+);base64,(.*)/);
                        if (match) {
                            const mimeType = match[1], base64Data = match[2], extension = mimeType.split('/')[1] || 'png';
                            const imagePath = `images/${modelId}_${image.id}.${extension}`;
                            zip.file(imagePath, base64Data, { base64: true }); image.dataUrl = imagePath;
                        }
                    }
                }
            }
            zip.file("settings.json", JSON.stringify(stateToExport, null, 2));
            const blob = await zip.generateAsync({ type: "blob" });
            const date = new Date().toISOString().slice(0, 10);
            const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `tts-settings-backup-${date}.zip`;
            document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(a.href);
            setStatus('設定のエクスポートが完了しました。');
        } catch (error) { console.error("エクスポートエラー:", error); setStatus(`エクスポートに失敗しました: ${error.message}`, true); }
    };

    const importZip = async (file) => {
        if (!confirm('現在の設定をすべて上書きしてインポートします。よろしいですか？')) return;
        setStatus('設定をインポート中...');
        try {
            const zip = await JSZip.loadAsync(file); const settingsFile = zip.file("settings.json");
            if (!settingsFile) throw new Error("ZIP内にsettings.jsonが見つかりません。");
            const settingsJson = await settingsFile.async("string"); const importedState = JSON.parse(settingsJson);
            for (const modelId in importedState) {
                if (modelId === 'uiSettings' || !importedState[modelId].images) continue;
                if (Array.isArray(importedState[modelId].images)) { importedState[modelId].images.sort((a, b) => a.id - b.id); }
                for (const image of importedState[modelId].images) {
                    if (typeof image.dataUrl === 'string' && image.dataUrl.startsWith('images/')) {
                        const imageFile = zip.file(image.dataUrl);
                        if (imageFile) {
                            const base64Data = await imageFile.async("base64");
                            const mimeType = `image/${image.dataUrl.split('.').pop()}`; image.dataUrl = `data:${mimeType};base64,${base64Data}`;
                        }
                    }
                }
            }
            appState = importedState; await saveState();
            alert('インポートが完了しました。ページをリロードします。'); location.reload();
        } catch (error) { console.error("インポートエラー:", error); setStatus(`インポートに失敗しました: ${error.message}`, true); }
    };

    function renderLoop() { if (isAdjustMode) { bodyElement.style.backgroundSize = `${100 * tempBgSettings.scale}%`; bodyElement.style.backgroundPosition = `${tempBgSettings.pixelX}px ${tempBgSettings.pixelY}px`; animationFrameId = requestAnimationFrame(renderLoop); } }
    function onBgMouseDown(e) { isDraggingBg = true; dragStart = { mouseX: e.clientX, mouseY: e.clientY, pixelX: tempBgSettings.pixelX, pixelY: tempBgSettings.pixelY }; bodyElement.classList.add('grabbing'); }
    function onBgMouseUp() { isDraggingBg = false; bodyElement.classList.remove('grabbing'); }
    function onBgMouseMove(e) { if (!isDraggingBg) return; const dx = e.clientX - dragStart.mouseX, dy = e.clientY - dragStart.mouseY; tempBgSettings.pixelX = dragStart.pixelX + dx; tempBgSettings.pixelY = dragStart.pixelY + dy; }
    function onBgWheel(e) { e.preventDefault(); const oldScale = tempBgSettings.scale; const newScale = Math.max(0.1, Math.min(oldScale - e.deltaY * 0.001 * oldScale, 10)); tempBgSettings.scale = newScale; const cursorX = e.clientX, cursorY = e.clientY; tempBgSettings.pixelX = cursorX - (cursorX - tempBgSettings.pixelX) * (newScale / oldScale); tempBgSettings.pixelY = cursorY - (cursorY - tempBgSettings.pixelY) * (newScale / oldScale); }
    function getDistance(t1, t2) { return Math.sqrt(Math.pow(t1.clientX - t2.clientX, 2) + Math.pow(t1.clientY - t2.clientY, 2)); }
    function onBgTouchStart(e) { if (e.touches.length === 1) { isPanning = true; panStart = { touchX: e.touches[0].clientX, touchY: e.touches[0].clientY, pixelX: tempBgSettings.pixelX, pixelY: tempBgSettings.pixelY }; } if (e.touches.length === 2) { isPinching = true; isPanning = false; lastPinchDist = getDistance(e.touches[0], e.touches[1]); } }
    function onBgTouchMove(e) { e.preventDefault(); if (isPanning && e.touches.length === 1) { const dx = e.touches[0].clientX - panStart.touchX; const dy = e.touches[0].clientY - panStart.touchY; tempBgSettings.pixelX = panStart.pixelX + dx; tempBgSettings.pixelY = panStart.pixelY + dy; } if (isPinching && e.touches.length === 2) { const oldScale = tempBgSettings.scale; const newDist = getDistance(e.touches[0], e.touches[1]); const newScale = Math.max(0.1, Math.min(oldScale * (newDist / lastPinchDist), 10)); tempBgSettings.scale = newScale; const cursorX = (e.touches[0].clientX + e.touches[1].clientX) / 2; const cursorY = (e.touches[0].clientY + e.touches[1].clientY) / 2; tempBgSettings.pixelX = cursorX - (cursorX - tempBgSettings.pixelX) * (newScale / oldScale); tempBgSettings.pixelY = cursorY - (cursorY - tempBgSettings.pixelY) * (newScale / oldScale); lastPinchDist = newDist; } }
    function onBgTouchEnd(e) { if (e.touches.length < 2) isPinching = false; if (e.touches.length < 1) isPanning = false; }
    const bgEventListeners = { mousedown: onBgMouseDown, mouseup: onBgMouseUp, mousemove: onBgMouseMove, wheel: onBgWheel, touchstart: onBgTouchStart, touchend: onBgTouchEnd, touchmove: onBgTouchMove };

    function startBgAdjustMode() {
        const activeImage = getActiveImage(getCurrentModelId()); if (!activeImage) { bgAdjustToggle.checked = false; return; }
        isAdjustMode = true; tempBgSettings.pixelX = activeImage.pixelX || 0; tempBgSettings.pixelY = activeImage.pixelY || 0; tempBgSettings.scale = activeImage.scale || 1.0;
        bodyElement.classList.add('bg-adjust-mode', 'no-transition'); setTimeout(() => bodyElement.classList.remove('no-transition'), 50);
        adjustModeControls.style.display = 'flex';
        for (const [event, handler] of Object.entries(bgEventListeners)) { window.addEventListener(event, handler, { passive: false }); }
        animationFrameId = requestAnimationFrame(renderLoop);
    }
    function endBgAdjustMode({ revert = false } = {}) {
        cancelAnimationFrame(animationFrameId); isAdjustMode = false; bgAdjustToggle.checked = false;
        bodyElement.classList.remove('bg-adjust-mode'); adjustModeControls.style.display = 'none';
        for (const [event, handler] of Object.entries(bgEventListeners)) { window.removeEventListener(event, handler); }
        if (revert) { applyBackground(getActiveImage(getCurrentModelId())); }
    }
    function performFadeSwitch(updateAction) {
        const oldStyle = window.getComputedStyle(bodyElement); bgFadeOverlay.style.transition = 'none';
        bgFadeOverlay.style.backgroundImage = oldStyle.backgroundImage; bgFadeOverlay.style.backgroundSize = oldStyle.backgroundSize;
        bgFadeOverlay.style.backgroundPosition = oldStyle.backgroundPosition; bgFadeOverlay.style.opacity = '1'; bgFadeOverlay.style.zIndex = -1;
        requestAnimationFrame(() => {
            bodyElement.classList.add('no-transition'); updateAction();
            requestAnimationFrame(() => {
                bodyElement.classList.remove('no-transition'); bgFadeOverlay.style.zIndex = 1;
                bgFadeOverlay.style.transition = 'opacity 0.5s ease-in-out'; bgFadeOverlay.style.opacity = '0';
            });
        });
    }
    const updateFormatSelectVisibility = () => {
        const opusOption = document.querySelector('#format-select option[value="opus"]'), flacOption = document.querySelector('#format-select option[value="flac"]');
        if(flacOption) flacOption.style.display = 'none'; if(opusOption) opusOption.style.display = SHOW_ADVANCED_FORMATS ? '' : 'none';
        if (formatSelect.value === 'flac') { formatSelect.value = 'mp3'; }
    }

    // --- 2. 認証UI ---
    async function handleEditUsername() {
        if (!currentUser) return;
        const currentName = userProfile ? userProfile.username : (currentUser.displayName || '');
        const newName = prompt("新しい表示名を入力してください（10文字以内）:", currentName);
        if (newName === null) { return; }
        const trimmedName = newName.trim();
        if (trimmedName === "") { alert("表示名は空にできません。"); return; }
        if (trimmedName.length > 10) { alert("表示名は10文字以内で入力してください。"); return; }
        try {
            const result = await window.api.updateProfile(trimmedName);
            userProfile = { username: result.username };
            document.getElementById('user-info').textContent = result.username;
            document.getElementById('user-info').title = result.username;
            alert("表示名を更新しました。");
        } catch (error) { console.error("表示名の更新に失敗しました:", error); alert(`エラーが発生しました: ${error.message}`); }
    }

    // --- 3. ストレージ (R2 & IndexedDB) ---
    function base64toBlob(base64, contentType = '', sliceSize = 512) {
        const byteCharacters = atob(base64); const byteArrays = [];
        for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
            const slice = byteCharacters.slice(offset, offset + sliceSize);
            const byteNumbers = new Array(slice.length);
            for (let i = 0; i < slice.length; i++) { byteNumbers[i] = slice.charCodeAt(i); }
            byteArrays.push(new Uint8Array(byteNumbers));
        }
        return new Blob(byteArrays, {type: contentType});
    }

    function renderR2Gallery(files) {
        r2GalleryContainer.querySelectorAll('audio[src^="blob:"]').forEach(audio => URL.revokeObjectURL(audio.src));
        if (r2GalleryState.currentPage === 1) { r2GalleryContainer.innerHTML = ''; }
        if (!files || files.length === 0) { if (r2GalleryState.currentPage === 1) { r2GalleryContainer.innerHTML = '<p>条件に一致する音声はありません。</p>'; } return; }
        const currentUid = currentUser ? currentUser.uid : null;
        files.forEach(file => {
            const card = document.createElement('div'); card.className = 'player-card'; card.dataset.fileKey = file.r2_key; card.dataset.userId = file.user_id;
            const isTestPost = file.is_test_post, modelDisplayName = getModelData(file.model_name).displayName || file.model_name;
            const formatConfig = getFormatConfigByContentType(isTestPost ? file.content_type : `audio/${file.r2_key.split('.').pop()}`);
            const downloadFilename = createSafeFileName(file.model_name, file.text_content, formatConfig.extension);
            const isOwnFile = currentUid && file.user_id === currentUid;
            const ownerUsername = file.username || '匿名ユーザー';
            const ownerIndicator = isOwnFile ? ` <span class="is-own">(自分)</span>` : '';
            const deleteBtnDataAttr = isTestPost ? `data-is-test-post="true"` : '';
            const actionButton = (isOwnFile || isTestPost) ? `<button class="icon-btn btn-delete-r2" title="削除" ${deleteBtnDataAttr}>🗑️</button>` : `<button class="icon-btn btn-view-user-files" title="この投稿者の他の音声">👤</button>`;
            let ownerInfoHtml = '';
            if (!r2GalleryState.userId) { ownerInfoHtml = `<span>${ownerUsername}${ownerIndicator}</span>`; }
            let audioSrc, downloadHref;
            if (isTestPost) { try { const blob = base64toBlob(file.audio_base_64, file.content_type); const url = URL.createObjectURL(blob); audioSrc = url; downloadHref = url; } catch (e) { console.error("Error creating blob URL for test post:", e); audioSrc = ''; downloadHref = '#'; } } 
            else { audioSrc = `/api/get/${encodeURIComponent(file.r2_key)}`; downloadHref = audioSrc; }
            card.innerHTML = `<div class="card-main"><div style="margin-bottom: 8px;"><div class="card-owner-info"><span>${modelDisplayName}</span>${ownerInfoHtml}</div><p style="margin: 0; color: #333; word-break: break-all;">${file.text_content}</p></div><audio controls preload="none" src="${audioSrc}"></audio></div><div class="player-actions"><a href="${downloadHref}" download="${downloadFilename}" class="icon-btn download-link" title="ダウンロード">📥</a> ${actionButton}</div>`;
            r2GalleryContainer.appendChild(card);
        });
    }

    function updateR2FilterStatusUI(username = null) {
        if (r2GalleryState.userId) {
            const displayName = username ? `「${username}」さん` : '特定ユーザー';
            r2FilterStatus.innerHTML = `${displayName}の投稿を表示中 <button id="clear-user-filter-btn">フィルター解除</button>`;
            r2FilterStatus.style.display = 'block';
            document.getElementById('clear-user-filter-btn').onclick = () => { r2GalleryState.userId = ''; r2GalleryState.currentPage = 1; loadR2Gallery(); };
        } else { r2FilterStatus.style.display = 'none'; }
    }

    function updateR2PaginationUI() {
        const hasContent = r2GalleryContainer.querySelector('.player-card');
        r2PaginationControls.style.display = (r2GalleryState.currentPage > 1 || r2GalleryState.hasNextPage || hasContent) ? 'flex' : 'none';
        r2PageInfo.textContent = `ページ ${r2GalleryState.currentPage}`;
        r2PrevPageBtn.disabled = r2GalleryState.currentPage <= 1 || r2GalleryState.isLoading;
        r2NextPageBtn.disabled = !r2GalleryState.hasNextPage || r2GalleryState.isLoading;
    }

    async function loadR2Gallery() {
        if (r2GalleryState.isLoading) return; r2GalleryState.isLoading = true; 
        if(r2GalleryState.currentPage === 1) r2GalleryContainer.innerHTML = '<p>読み込み中...</p>';
        updateR2PaginationUI(); updateR2FilterStatusUI(); 
        try {
            const params = new URLSearchParams({ page: r2GalleryState.currentPage, filter: r2GalleryState.filter, limit: R2_ITEMS_PER_PAGE });
            if (r2GalleryState.modelId) params.append('modelId', r2GalleryState.modelId);
            if (r2GalleryState.searchText) params.append('searchText', r2GalleryState.searchText);
            if (r2GalleryState.userId) params.append('userId', r2GalleryState.userId);
            const filesFromServer = await window.api.listFromR2(params);
            r2GalleryState.hasNextPage = filesFromServer.length === R2_ITEMS_PER_PAGE;
            let allTestPosts = await getAllTestPosts();
            let filteredTestPosts = allTestPosts.filter(post => {
                const state = r2GalleryState;
                if (state.filter === 'mine' && (!currentUser || post.user_id !== currentUser.uid)) return false;
                if (state.userId && post.user_id !== state.userId) return false;
                if (state.modelId && post.model_name !== state.modelId) return false;
                if (state.searchText && !post.text_content.toLowerCase().includes(state.searchText.toLowerCase())) return false;
                return true;
            });
            const combinedFiles = [...filesFromServer, ...filteredTestPosts].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            const startIndex = (r2GalleryState.currentPage - 1) * R2_ITEMS_PER_PAGE, endIndex = startIndex + R2_ITEMS_PER_PAGE;
            const pagedFiles = combinedFiles.slice(startIndex, endIndex);
            r2GalleryState.hasNextPage = combinedFiles.length > endIndex;
            if (r2GalleryState.userId && combinedFiles.length > 0) {
                const userFile = combinedFiles.find(f => f.user_id === r2GalleryState.userId);
                if (userFile) { updateR2FilterStatusUI(userFile.username || '匿名ユーザー'); }
            }
            renderR2Gallery(pagedFiles);
        } catch (error) { console.error('R2 gallery load error:', error); r2GalleryContainer.innerHTML = `<p class="status-error" style="padding:10px; border-radius:4px;">エラー: ${error.message}</p>`; r2GalleryState.hasNextPage = false;
        } finally { r2GalleryState.isLoading = false; updateR2PaginationUI(); }
    }

    async function saveAudioAsTestPost(blob, modelId, text, button) {
        if (!blob || !modelId || !text) { setStatus('テスト投稿の対象データが不完全です。', true); return; }
        setStatus('テスト投稿を準備中...'); button.disabled = true;
        try {
            const userId = currentUser ? currentUser.uid : 'local-user';
            const username = userProfile ? userProfile.username : (currentUser ? currentUser.displayName : '自分 (未ログイン)');
            const reader = new FileReader(); reader.readAsDataURL(blob);
            reader.onloadend = async () => {
                try {
                    const base64Audio = reader.result.split(',')[1];
                    const newPost = { r2_key: `test_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`, model_name: modelId, text_content: text, user_id: userId, username: username, audio_base_64: base64Audio, content_type: blob.type, is_test_post: true, created_at: new Date().toISOString() };
                    await addTestPost(newPost); await enforceLimit();
                    setStatus('テスト投稿をブラウザに保存しました。');
                    document.querySelector('.tab-button[data-tab="r2-gallery"]').click();
                } catch(dbError) { console.error('IndexedDBへの保存エラー:', dbError); setStatus(`テスト投稿の保存に失敗しました: ${dbError.message}`, true); }
            };
            reader.onerror = () => { throw new Error("ファイルの読み込みに失敗しました。"); };
        } catch (error) { console.error('Test post save error:', error); setStatus(`テスト投稿の作成に失敗しました: ${error.message}`, true);
        } finally { button.disabled = false; }
    }

    async function saveAudioToR2(blob, modelId, text, button) {
        if (!blob || !modelId || !text) { setStatus('保存対象の音声データが不完全です。', true); return; }
        setStatus('R2に音声を保存中...'); button.disabled = true;
        try {
            const reader = new FileReader(); reader.readAsDataURL(blob);
            reader.onloadend = async () => {
                try {
                    const base64Audio = reader.result.split(',')[1];
                    await window.api.uploadToR2({ modelId: modelId, text: text, audioBase64: base64Audio, contentType: blob.type });
                    setStatus('音声をR2に保存しました。');
                    const r2TabButton = document.querySelector('.tab-button[data-tab="r2-gallery"]');
                    if(r2TabButton && !r2TabButton.classList.contains('locked-feature')) r2TabButton.click();
                } catch (err) {
                    console.error('R2 save error:', err);
                    if (err.isMuted) {
                        setStatus(err.message);
                        await saveAudioAsTestPost(blob, modelId, text, button);
                        return;
                    }
                    setStatus(err.message, true);
                } finally { if (button.disabled) { button.disabled = false; } }
            };
            reader.onerror = (error) => { throw error; };
        } catch (error) { console.error('File reading error:', error); setStatus('ファイルの読み込みに失敗しました。', true); button.disabled = false; }
    }
    
    // --- 4. 音声生成と音声加工 ---
    const getFormatConfigByContentType = (contentType) => {
        if (!contentType) return { extension: 'bin', contentType: 'application/octet-stream' };
        return Object.values(AudioEditing.FORMAT_MAPPING).find(config => config.contentType === contentType.split(';')[0].trim()) || { extension: 'bin', contentType };
    };
    
    const createSafeFileName = (modelId, text, extension) => {
        const cleanModelId = (modelId || 'UnknownModelId').replace(/[\\/:*?"<>|]/g, '_').trim();
        const cleanText = (text || 'NoText').substring(0, 30).replace(/[\\/:*?"<>|]/g, '_').trim();
        return `${cleanModelId}_${cleanText}.${extension}`;
    }

    const validateInput = (lines) => {
        const errors = [];
        if (lines.length > 10) errors.push(`最大10行までです。`);
        if (lines.some(line => line.length > 50)) errors.push(`1行あたり最大50文字までです。`);
        if (styleIdInput.value === '' || isNaN(parseInt(styleIdInput.value, 10))) errors.push('スタイルIDは数字で入力してください。');
        if (errors.length > 0) { setStatus(errors.join(' / '), true); return false; } return true;
    };

    const addHistoryEntry = (cardId, newEntry) => { const state = resultStates[cardId]; if (!state) return; state.history.splice(state.currentIndex + 1); state.history.push(newEntry); state.currentIndex = state.history.length - 1; };

    const updateCardUI = (cardId) => {
        const state = resultStates[cardId]; if (!state) return;
        const card = document.querySelector(`[data-card-id="${cardId}"]`); if (!card) return;
        const audio = card.querySelector('audio'), downloadLink = card.querySelector('.download-link');
        const undoBtn = card.querySelector('.btn-undo'), redoBtn = card.querySelector('.btn-redo');
        const errorMessageDiv = card.querySelector('.error-message'), editableText = card.querySelector('.editable-text');
        const hasAudio = state.history.length > 0 && state.currentIndex >= 0; const isTrueError = !!state.error;
        card.classList.toggle('is-error', isTrueError); audio.style.display = hasAudio ? 'block' : 'none';
        downloadLink.style.display = hasAudio ? 'flex' : 'none'; undoBtn.style.display = hasAudio ? 'flex' : 'none';
        redoBtn.style.display = hasAudio ? 'flex' : 'none'; errorMessageDiv.style.display = !hasAudio ? 'block' : 'none';
        if (!hasAudio) {
            if (isTrueError) { errorMessageDiv.textContent = `エラー: ${state.error}`; errorMessageDiv.style.color = ''; } 
            else { errorMessageDiv.textContent = 'テキストを入力し、再生成ボタン(↻)を押してください。'; errorMessageDiv.style.color = '#6c757d'; }
            editableText.textContent = state.initialText;
        } else {
            const currentHistoryEntry = state.history[state.currentIndex]; editableText.textContent = currentHistoryEntry.text;
            if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
            const url = URL.createObjectURL(currentHistoryEntry.blob); state.audioUrl = url; audio.src = url; downloadLink.href = url;
            const formatConfig = getFormatConfigByContentType(currentHistoryEntry.blob.type);
            downloadLink.download = createSafeFileName(getCurrentModelId(), currentHistoryEntry.text, formatConfig.extension);
        }
        undoBtn.disabled = !hasAudio || state.currentIndex <= 0; redoBtn.disabled = !hasAudio || state.currentIndex >= state.history.length - 1;
    };

    const addResultCard = async (result, insertAfterCard = null) => {
        const cardId = `card-${Date.now()}-${Math.random()}`; const card = document.createElement('div'); card.className = 'player-card'; card.dataset.cardId = cardId;
        card.innerHTML = `<div class="card-main"><div class="card-text-wrapper"><span class="card-index"></span><p class="editable-text" contenteditable="true"></p></div><audio controls style="display: none;"></audio><div class="error-message" style="display: none;"></div><div class="card-status"></div></div><div class="card-actions-wrapper"><div class="player-actions"><button class="icon-btn btn-regenerate" title="再生成">↻</button><button class="icon-btn btn-undo" title="元に戻す">↩</button><button class="icon-btn btn-redo" title="やり直す">↪</button><a class="download-link icon-btn" title="ダウンロード" style="display: none;">📥</a><button class="icon-btn btn-add" title="下に新規追加">⊕</button><button class="icon-btn btn-delete" title="削除">🗑️</button></div><div class="interval-control" style="display: none;"><label for="interval-${cardId}">間隔:</label><input type="number" id="interval-${cardId}" class="interval-input" value="0" step="0.05"><span>秒</span></div></div>`;
        if (result.status === 'success') {
            try { const audioBlob = await AudioEditing.processServerResponseAudio(result.audio_base_64, result.content_type, formatSelect.value); resultStates[cardId] = { initialText: result.text, history: [{ blob: audioBlob, text: result.text }], currentIndex: 0, error: null, audioUrl: null }; } 
            catch (error) { resultStates[cardId] = { initialText: result.text, history: [], currentIndex: -1, error: error.message, audioUrl: null }; }
        } else { resultStates[cardId] = { initialText: result.text, history: [], currentIndex: -1, error: result.reason || null, audioUrl: null }; }
        if (insertAfterCard) { insertAfterCard.after(card); } else { resultsContainer.appendChild(card); }
        updateCardUI(cardId); updateAllCardUIs(); return card;
    };

    const updateAllCardUIs = () => {
        const cards = resultsContainer.querySelectorAll('.player-card');
        cards.forEach((card, index) => {
            const indexSpan = card.querySelector('.card-index'); if(indexSpan) indexSpan.textContent = `[${index + 1}]`;
            const intervalControl = card.querySelector('.interval-control'); if(intervalControl) intervalControl.style.display = (index < cards.length - 1) ? 'flex' : 'none';
        });
        const validAudioCount = Array.from(cards).filter(card => { const state = resultStates[card.dataset.cardId]; return state && state.history.length > 0 && state.currentIndex >= 0; }).length;
        resultsPlaceholder.style.display = cards.length > 0 ? 'none' : 'block'; generatePreviewBtn.disabled = validAudioCount < 1;
    };

    async function handleRegenerate(card) {
        const cardId = card.dataset.cardId; const state = resultStates[cardId];
        const regenBtn = card.querySelector('.btn-regenerate'), cardStatus = card.querySelector('.card-status');
        const editableText = card.querySelector('.editable-text'), currentText = editableText.textContent.trim();
        if (!currentText) { cardStatus.textContent = 'テキストが空です。'; return; }
        if (regenBtn) regenBtn.disabled = true; cardStatus.textContent = '再生成中...';
        try {
            const requestFormat = formatSelect.value === 'wav' ? 'flac' : formatSelect.value;
            const payload = { model_id: getCurrentModelId(), texts: [currentText], style_id: styleIdInput.value, style_strength: parseFloat(styleStrengthInput.value), format: requestFormat };
            const results = await window.api.synthesize(payload);
            if (results && results[0] && results[0].status === 'success') {
                const newBlob = await AudioEditing.processServerResponseAudio(results[0].audio_base_64, results[0].content_type, formatSelect.value);
                addHistoryEntry(cardId, { blob: newBlob, text: currentText }); state.error = null;
            } else { const reason = (results && results[0] && results[0].reason) || '不明なエラー'; state.error = reason; }
        } catch (error) { state.error = error.message; }
        finally { if (regenBtn) regenBtn.disabled = false; cardStatus.textContent = ''; updateCardUI(cardId); updateAllCardUIs(); }
    }

    // --- 5. イベントリスナー設定 ---
    function setupEventListeners() {
        // Auth
        loginBtn.addEventListener('click', () => window.authProvider.login());
        logoutBtn.addEventListener('click', () => window.authProvider.logout());
        editUsernameBtn.addEventListener('click', handleEditUsername);
        
        // Settings
        tabButtons.forEach(button => button.addEventListener('click', () => {
            bodyElement.classList.add('no-transition');
            tabButtons.forEach(btn => btn.classList.remove('active')); tabContents.forEach(content => content.classList.remove('active'));
            button.classList.add('active'); document.getElementById(`tab-${button.dataset.tab}`).classList.add('active');
            if (button.dataset.tab === 'r2-gallery' && !button.classList.contains('locked-feature')) { r2GalleryState.currentPage = 1; loadR2Gallery(); }
            if (isAdjustMode) { endBgAdjustMode({ revert: true }); }
            setTimeout(() => bodyElement.classList.remove('no-transition'), 50);
        }));
        const uiSettingsMap = [ { slider: uiWidthSlider, input: uiWidthInput, key: 'width' }, { slider: uiOpacitySlider, input: uiOpacityInput, key: 'opacity' } ];
        uiSettingsMap.forEach(({ slider, input, key }) => {
            const handler = e => { appState.uiSettings[key] = e.target.value; applyUiSettings(); };
            slider.addEventListener('input', e => { input.value = e.target.value; handler(e); });
            input.addEventListener('input', e => { slider.value = e.target.value; handler(e); });
            slider.addEventListener('change', saveState); input.addEventListener('change', saveState);
        });
        resetUiBtn.addEventListener('click', () => {
            if (confirm('現在のUI設定（横幅、透過度、位置）をすべてデフォルトに戻します。よろしいですか？')) {
                const defaultWidth = 700; appState.uiSettings = { ...defaultUiSettings, width: defaultWidth, posX: (window.innerWidth - defaultWidth) / 2 };
                saveState(); applyUiSettings(); setStatus('UI設定をリセットしました。');
            }
        });
        let isDragging = false, initialMouseX, initialMouseY, initialUiPosX, initialUiPosY;
        containerHeader.addEventListener('mousedown', e => {
            if (e.target.closest('.tab-button')) return; isDragging = true; bodyElement.classList.add('ui-dragging');
            containerWrapper.style.transition = 'none'; initialMouseX = e.clientX; initialMouseY = e.clientY;
            initialUiPosX = containerWrapper.offsetLeft; initialUiPosY = containerWrapper.offsetTop; e.preventDefault();
        });
        window.addEventListener('mousemove', e => {
            if (!isDragging) return;
            let newPosX = initialUiPosX + (e.clientX - initialMouseX), newPosY = initialUiPosY + (e.clientY - initialMouseY);
            newPosX = Math.max(0, Math.min(window.innerWidth - containerWrapper.offsetWidth, newPosX));
            newPosY = Math.max(0, Math.min(window.innerHeight - containerWrapper.offsetHeight, newPosY));
            containerWrapper.style.left = `${newPosX}px`; containerWrapper.style.top = `${newPosY}px`;
        });
        window.addEventListener('mouseup', () => {
            if (!isDragging) return; isDragging = false; bodyElement.classList.remove('ui-dragging');
            containerWrapper.style.transition = 'max-width 0.3s, opacity 0.3s, visibility 0.3s, left 0.3s, top 0.3s';
            appState.uiSettings.posX = containerWrapper.offsetLeft; appState.uiSettings.posY = containerWrapper.offsetTop; saveState();
        });
        resetAllBgsBtn.addEventListener('click', async () => {
            const confirmationText = "背景リセット";
            const userInput = prompt(`この操作は元に戻せません。\n全てのモデルの表示名と背景画像が削除されます。\n\nリセットを実行するには「${confirmationText}」と入力してください。`);
            if (userInput === confirmationText) {
                try {
                    const uiSettingsToKeep = { ...appState.uiSettings }; await clearSettingsStore();
                    appState = { uiSettings: uiSettingsToKeep }; await saveAllSettings(appState);
                    alert('すべての背景設定がリセットされました。ページをリロードします。'); location.reload();
                } catch (error) { console.error("リセットエラー:", error); alert("リセット処理中にエラーが発生しました。"); }
            } else if (userInput !== null) { alert('入力が一致しませんでした。リセットはキャンセルされました。'); }
        });
        [modelSelectTTS, modelSelectBG].forEach(sel => sel.addEventListener('change', (e) => {
            const newModelId = e.target.value; modelSelectTTS.value = newModelId; modelSelectBG.value = newModelId;
            performFadeSwitch(() => renderUIForSelectedModel());
        }));
        saveDisplayNameBtn.addEventListener('click', () => { const modelId = getCurrentModelId(); if (modelId) { getModelData(modelId).displayName = displayNameInput.value.trim(); saveState(); updateSelectOptions(); } });
        displayNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveDisplayNameBtn.click(); } });
        bodyElement.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); if (!isAdjustMode) bodyElement.classList.add('drag-over'); });
        bodyElement.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); bodyElement.classList.remove('drag-over'); });
        bodyElement.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); bodyElement.classList.remove('drag-over'); if (e.dataTransfer.files.length > 0) { handleFile(e.dataTransfer.files[0]); } });
        uploadImageBtn.addEventListener('click', () => imageUploadInput.click());
        imageUploadInput.addEventListener('change', (e) => { if (e.target.files.length > 0) { handleFile(e.target.files[0]); } e.target.value = null; });
        galleryContainer.addEventListener('click', (e) => {
            const item = e.target.closest('.gallery-item'); if (!item) return; const modelId = getCurrentModelId(); if (!modelId) return; const modelData = getModelData(modelId);
            if (item.dataset.action === 'clear-bg') { if (modelData.activeImageId !== null) { modelData.activeImageId = null; saveState(); performFadeSwitch(() => renderUIForSelectedModel()); } return; }
            const imageId = Number(item.dataset.imageId); if (!imageId) return;
            if (e.target.classList.contains('btn-delete-img')) {
                const imageToDelete = modelData.images.find(img => img.id === imageId);
                if (imageToDelete && confirm(`画像「${imageToDelete.name}」を削除しますか？`)) {
                    const wasActive = modelData.activeImageId === imageId; const deletedIndex = modelData.images.findIndex(img => img.id === imageId);
                    modelData.images = modelData.images.filter(img => img.id !== imageId);
                    if (wasActive) { if (modelData.images.length > 0) { const newActiveIndex = Math.max(0, deletedIndex - 1); modelData.activeImageId = modelData.images[newActiveIndex].id; } else { modelData.activeImageId = null; } saveState(); performFadeSwitch(() => renderUIForSelectedModel()); } 
                    else { saveState(); renderGallery(modelId); }
                }
            } else if (e.target.closest('img')) { modelData.activeImageId = imageId; saveState(); performFadeSwitch(() => renderUIForSelectedModel()); }
        });
        bgAdjustToggle.addEventListener('change', () => { bgAdjustToggle.checked ? startBgAdjustMode() : endBgAdjustMode({ revert: true }); });
        revertBgChangesBtn.addEventListener('click', () => endBgAdjustMode({ revert: true }));
        applyBgChangesBtn.addEventListener('click', () => {
            const activeImage = getActiveImage(getCurrentModelId());
            if (activeImage) {
                activeImage.pixelX = tempBgSettings.pixelX; activeImage.pixelY = tempBgSettings.pixelY; activeImage.scale = tempBgSettings.scale;
                activeImage.name = createImageName(activeImage); saveState(); renderGallery(getCurrentModelId()); applyBackground(activeImage); setStatus('背景設定を適用しました。');
            } endBgAdjustMode();
        });
        exportAllSettingsBtn.addEventListener('click', exportAllSettings);
        
        // Storage
        saveToR2Btn.addEventListener('click', () => saveAudioToR2(currentCombinedAudioBlob, getCurrentModelId(), currentCombinedAudioInfo.text, saveToR2Btn));
        savePreviewToR2Btn.addEventListener('click', () => saveAudioToR2(currentPreviewAudioBlob, getCurrentModelId(), currentPreviewAudioInfo.text, savePreviewToR2Btn));
        refreshR2GalleryBtn.addEventListener('click', () => { r2GalleryState.currentPage = 1; r2GalleryState.userId = ''; loadR2Gallery(); });
        r2FilterMineToggle.addEventListener('change', () => { r2GalleryState.filter = r2FilterMineToggle.checked ? 'mine' : 'all'; r2GalleryState.currentPage = 1; r2GalleryState.userId = ''; loadR2Gallery(); });
        const handleSearch = () => { r2GalleryState.modelId = r2SearchModelSelect.value; r2GalleryState.searchText = r2SearchTextInput.value; r2GalleryState.currentPage = 1; r2GalleryState.userId = ''; loadR2Gallery(); };
        r2SearchModelSelect.addEventListener('change', handleSearch); r2SearchTextInput.addEventListener('input', handleSearch);
        r2PrevPageBtn.addEventListener('click', () => { if (r2GalleryState.currentPage > 1) { r2GalleryState.currentPage--; loadR2Gallery(); } });
        r2NextPageBtn.addEventListener('click', () => { if (r2GalleryState.hasNextPage) { r2GalleryState.currentPage++; loadR2Gallery(); } });
        r2GalleryContainer.addEventListener('click', async (e) => {
            const card = e.target.closest('.player-card'); if (!card) return; const deleteButton = e.target.closest('.btn-delete-r2');
            if (deleteButton) {
                const fileKey = card.dataset.fileKey; const isTestPost = deleteButton.dataset.isTestPost === 'true';
                if (isTestPost) { if (confirm(`このテスト投稿をブラウザから削除しますか？`)) { try { await deleteTestPost(fileKey); const audioEl = card.querySelector('audio'); if (audioEl && audioEl.src.startsWith('blob:')) { URL.revokeObjectURL(audioEl.src); } card.remove(); } catch(dbError) { alert(`削除に失敗しました: ${dbError.message}`); } } }
                else { const filename = card.querySelector('.download-link')?.download || fileKey; if (confirm(`ファイル「${filename}」を完全に削除しますか？この操作は元に戻せません。`)) { try { deleteButton.disabled = true; await window.api.deleteFromR2(fileKey); loadR2Gallery(); } catch(error) { alert(error.message); deleteButton.disabled = false; } } }
            } else if (e.target.closest('.btn-view-user-files')) { r2GalleryState.userId = card.dataset.userId; r2GalleryState.currentPage = 1; r2GalleryState.filter = 'all'; r2FilterMineToggle.checked = false; loadR2Gallery(); }
        });

        // Audio
        styleStrengthInput.addEventListener('input', () => { strengthValueSpan.textContent = parseFloat(styleStrengthInput.value).toFixed(2); });
        resultsContainer.addEventListener('click', async (e) => {
            const button = e.target.closest('.icon-btn'); if (!button) return; const card = button.closest('.player-card'), cardId = card.dataset.cardId;
            if (button.classList.contains('btn-regenerate')) { await handleRegenerate(card); } 
            else if (button.classList.contains('btn-undo')) { const state = resultStates[cardId]; if (state && state.currentIndex > 0) { state.currentIndex--; updateCardUI(cardId); } } 
            else if (button.classList.contains('btn-redo')) { const state = resultStates[cardId]; if (state && state.currentIndex < state.history.length - 1) { state.currentIndex++; updateCardUI(cardId); } } 
            else if (button.classList.contains('btn-add')) { await addResultCard({ status: 'empty', text: '' }, card); } 
            else if (button.classList.contains('btn-delete')) { const state = resultStates[cardId]; if (confirm('このブロックを削除しますか？')) { if (state && state.audioUrl) URL.revokeObjectURL(state.audioUrl); delete resultStates[cardId]; card.remove(); updateAllCardUIs(); } }
        });
        resultsContainer.addEventListener('keydown', async (e) => { if (e.target.classList.contains('editable-text') && e.key === 'Enter') { e.preventDefault(); const card = e.target.closest('.player-card'); if (card) { e.target.blur(); await handleRegenerate(card); } } });
        generateBtn.addEventListener('click', async () => {
            Object.values(resultStates).forEach(state => { if (state.audioUrl) URL.revokeObjectURL(state.audioUrl); });
            resultsContainer.innerHTML = ''; resultStates = {}; combinedPreviewArea.style.display = 'none'; updateAllCardUIs(); combinedResultContainer.style.display = 'none'; saveToR2Btn.style.display = 'none';
            currentCombinedAudioBlob = null; currentCombinedAudioInfo = { text: '', filename: '' };
            let lines = textInput.value.split('\n').filter(line => line.trim() !== '');
            if (lines.length === 0) { setStatus('テキストを入力してください。', true); return; }
            if (!validateInput(lines)) return;
            generateBtn.disabled = true; generatePreviewBtn.disabled = true; setStatus(`${lines.length}件の音声を生成中...`);
            let results = null;
            try {
                const requestFormat = formatSelect.value === 'wav' ? 'flac' : formatSelect.value;
                const payload = { model_id: getCurrentModelId(), texts: lines, style_id: styleIdInput.value, style_strength: parseFloat(styleStrengthInput.value), format: requestFormat };
                results = await window.api.synthesize(payload);
            } catch (error) { setStatus(error.message, true); } finally { generateBtn.disabled = false; updateAllCardUIs(); }
            if (!results) { for (const line of lines) { await addResultCard({ text: line, status: 'error', reason: statusDiv.textContent || 'サーバーとの通信に失敗しました。' }); } setStatus(`音声生成リクエストに失敗しました。「合成結果」タブで詳細を確認してください。`, true); return; }
            let successCount = 0; const successfulBlobs = [];
            for (const result of results) {
                await addResultCard(result);
                if (result.status === 'success') { try { const decodedBlob = await AudioEditing.processServerResponseAudio(result.audio_base_64, result.content_type, formatSelect.value); successfulBlobs.push(decodedBlob); successCount++; } catch (e) { console.error("Audio decoding failed for preview:", e); } }
            }
            if (successCount > 0) { setStatus(`${successCount} / ${results.length} 件の音声を生成しました。「合成結果」タブで個別に確認・ダウンロードできます。`); } else { setStatus(`音声の生成に失敗しました。「合成結果」タブでエラー内容を確認してください。`, true); }
            if (successfulBlobs.length > 0) {
                if (combinedAudioPlayer.src) URL.revokeObjectURL(combinedAudioPlayer.src);
                const combinedBlob = await AudioEditing.combineAudioBlobs(successfulBlobs, [], formatSelect.value);
                if(combinedBlob) {
                    currentCombinedAudioBlob = combinedBlob; const url = URL.createObjectURL(combinedBlob); combinedAudioPlayer.src = url;
                    const formatConfig = getFormatConfigByContentType(combinedBlob.type); const successfulLines = results.filter(r => r.status === 'success').map(r => r.text);
                    const combinedText = successfulLines.join('_'); currentCombinedAudioInfo.text = successfulLines.join('\n');
                    currentCombinedAudioInfo.filename = createSafeFileName(getCurrentModelId(), combinedText, formatConfig.extension);
                    downloadCombinedBtn.onclick = () => { const a = document.createElement('a'); a.href = url; a.download = currentCombinedAudioInfo.filename; document.body.appendChild(a); a.click(); document.body.removeChild(a); };
                    downloadCombinedBtn.style.backgroundColor = 'var(--primary-color)'; combinedResultContainer.style.display = 'block';
                    downloadCombinedBtn.style.display = 'block'; saveToR2Btn.style.display = currentUser ? 'block' : 'none';
                    downloadCombinedBtn.textContent = successfulBlobs.length > 1 ? '結合音声をダウンロード' : 'この音声をダウンロード';
                }
            }
        });
        generatePreviewBtn.addEventListener('click', async () => {
            const validAudios = [], intervals = []; const allCards = resultsContainer.querySelectorAll('.player-card');
            for (let i = 0; i < allCards.length; i++) {
                const card = allCards[i], cardId = card.dataset.cardId, state = resultStates[cardId];
                if (state && state.history.length > 0 && state.currentIndex >= 0) {
                    validAudios.push({ blob: state.history[state.currentIndex].blob, text: state.history[state.currentIndex].text });
                    if (i < allCards.length - 1) { intervals.push(parseFloat(card.querySelector('.interval-input').value) || 0); }
                }
            }
            if (validAudios.length === 0) { setStatus('結合する有効な音声がありません。', true); return; }
            let statusMessage = '音声ファイルを結合中...';
            if (intervals.some(i => i < 0)) statusMessage = '音声を重ね合わせるため、WAV形式で結合します...';
            else if (intervals.some(i => i > 0)) statusMessage = '無音区間を挟むため、WAV形式で結合します...';
            setStatus(statusMessage); generatePreviewBtn.disabled = true;
            try {
                const { combinedBlob, finalFormat } = await AudioEditing.createAdvancedCombinedAudio(validAudios, intervals);
                if (!combinedBlob) throw new Error('音声の結合に失敗しました。');
                setStatus('結合プレビューが生成されました。');
                if (combinedPreviewPlayer.src) URL.revokeObjectURL(combinedPreviewPlayer.src);
                currentPreviewAudioBlob = combinedBlob; const formatConfig = AudioEditing.FORMAT_MAPPING[finalFormat] || AudioEditing.FORMAT_MAPPING['wav'];
                const combinedTextForFilename = validAudios.map(a => a.text).join('_');
                currentPreviewAudioInfo.text = validAudios.map(a => a.text).join('\n');
                currentPreviewAudioInfo.filename = createSafeFileName(getCurrentModelId(), combinedTextForFilename, formatConfig.extension);
                const url = URL.createObjectURL(combinedBlob); combinedPreviewPlayer.src = url; combinedPreviewArea.style.display = 'block';
                downloadCombinedPreviewBtn.textContent = `この結合音声 (${finalFormat.toUpperCase()}) をダウンロード`;
                downloadCombinedPreviewBtn.onclick = () => { const a = document.createElement('a'); a.href = url; a.download = currentPreviewAudioInfo.filename; document.body.appendChild(a); a.click(); document.body.removeChild(a); };
            } catch (error) { console.error("Error during preview generation:", error); setStatus(error.message, true); } 
            finally { generatePreviewBtn.disabled = false; }
        });
        addFirstCardBtn.addEventListener('click', () => addResultCard({ status: 'empty', text: '' }));
    }
    
    // --- 6. アプリケーションのエントリーポイントと公開API ---
    window.app = {
        init: async () => {
            // DOM要素を取得
            modelSelectTTS = document.getElementById('model-select-tts'); modelSelectBG = document.getElementById('model-select-bg'); formatSelect = document.getElementById('format-select'); generateBtn = document.getElementById('generate-btn'); generatePreviewBtn = document.getElementById('generate-preview-btn'); textInput = document.getElementById('text'); styleIdInput = document.getElementById('style-id-input'); styleStrengthInput = document.getElementById('style_strength'); strengthValueSpan = document.getElementById('strength-value'); statusDiv = document.getElementById('status'); resultsContainer = document.getElementById('results-container'); combinedResultContainer = document.getElementById('combined-result-container'); combinedAudioPlayer = document.getElementById('combined-audio-player'); downloadCombinedBtn = document.getElementById('download-combined-btn'); combinedPreviewArea = document.getElementById('combined-preview-area'); combinedPreviewPlayer = document.getElementById('combined-preview-player'); downloadCombinedPreviewBtn = document.getElementById('download-combined-preview-btn'); containerWrapper = document.querySelector('.container-wrapper'); bodyElement = document.body; containerHeader = document.querySelector('.container-header'); uiWidthSlider = document.getElementById('ui-width-slider'); uiWidthInput = document.getElementById('ui-width-input'); uiOpacitySlider = document.getElementById('ui-opacity-slider'); uiOpacityInput = document.getElementById('ui-opacity-input'); displayNameInput = document.getElementById('display-name-input'); saveDisplayNameBtn = document.getElementById('save-display-name-btn'); galleryContainer = document.getElementById('gallery-container'); tabButtons = document.querySelectorAll('.tab-button'); tabContents = document.querySelectorAll('.tab-content'); resetUiBtn = document.getElementById('reset-ui-btn'); resetAllBgsBtn = document.getElementById('reset-all-bgs-btn'); uploadImageBtn = document.getElementById('upload-image-btn'); imageUploadInput = document.getElementById('image-upload-input'); exportAllSettingsBtn = document.getElementById('export-all-settings-btn'); bgAdjustToggle = document.getElementById('bg-adjust-toggle'); bgFadeOverlay = document.getElementById('bg-fade-overlay'); adjustModeControls = document.getElementById('adjust-mode-controls'); revertBgChangesBtn = document.getElementById('revert-bg-changes-btn'); applyBgChangesBtn = document.getElementById('apply-bg-changes-btn'); resultsPlaceholder = document.getElementById('results-placeholder'); addFirstCardBtn = document.getElementById('add-first-card-btn'); saveToR2Btn = document.getElementById('save-to-r2-btn'); r2GalleryContainer = document.getElementById('r2-gallery-container'); refreshR2GalleryBtn = document.getElementById('refresh-r2-gallery-btn'); savePreviewToR2Btn = document.getElementById('save-preview-to-r2-btn'); r2SearchModelSelect = document.getElementById('r2-search-model-select'); r2SearchTextInput = document.getElementById('r2-search-text-input'); r2FilterMineToggle = document.getElementById('r2-filter-mine-toggle'); r2FilterStatus = document.getElementById('r2-filter-status'); r2PaginationControls = document.getElementById('r2-pagination-controls'); r2PrevPageBtn = document.getElementById('r2-prev-page-btn'); r2NextPageBtn = document.getElementById('r2-next-page-btn'); r2PageInfo = document.getElementById('r2-page-info'); loginBtn = document.getElementById('login-btn'); logoutBtn = document.getElementById('logout-btn'); editUsernameBtn = document.getElementById('edit-username-btn');
            
            await initDB();
            await loadState();
            applyUiSettings();
            updateFormatSelectVisibility();
            setupEventListeners();
            updateAllCardUIs();
        },
        ui: {
            initializeModels: (models) => {
                originalModels = models;
                const modelOptions = models.map(model => `<option value="${model.id}">${model.name}</option>`).join('');
                [modelSelectTTS, modelSelectBG].forEach(sel => { sel.innerHTML = modelOptions; });
                if (models.length > 0) { updateSelectOptions(); renderUIForSelectedModel(); } 
                else { setStatus('利用可能なモデルがありません。', true); }
            },
            updateAuthUI: (user, profile) => {
                currentUser = user; userProfile = profile;
                const userDisplayWrapper = document.getElementById('user-display-wrapper'), userInfo = document.getElementById('user-info');
                const r2GalleryTab = document.querySelector('.tab-button[data-tab="r2-gallery"]'), r2GalleryWrapper = document.getElementById('r2-gallery-wrapper');
                if (user) {
                    loginBtn.style.display = 'none'; logoutBtn.style.display = 'block'; userDisplayWrapper.style.display = 'flex';
                    const displayName = profile ? profile.username : (user.displayName || user.email);
                    userInfo.textContent = displayName; userInfo.title = displayName;
                    r2GalleryTab.classList.remove('locked-feature'); r2GalleryWrapper.classList.remove('locked-feature');
                    if (saveToR2Btn) saveToR2Btn.disabled = false; if (savePreviewToR2Btn) savePreviewToR2Btn.disabled = false;
                    if (r2FilterMineToggle) r2FilterMineToggle.disabled = false;
                    if (r2GalleryTab.classList.contains('active')) { loadR2Gallery(); }
                } else {
                    loginBtn.style.display = 'block'; logoutBtn.style.display = 'none'; userDisplayWrapper.style.display = 'none';
                    r2GalleryTab.classList.add('locked-feature'); r2GalleryWrapper.classList.add('locked-feature');
                    if (saveToR2Btn) saveToR2Btn.disabled = true; if (savePreviewToR2Btn) savePreviewToR2Btn.disabled = true;
                    if (r2FilterMineToggle) { r2FilterMineToggle.checked = false; r2FilterMineToggle.disabled = true; }
                    if (r2GalleryTab.classList.contains('active')) { document.querySelector('.tab-button[data-tab="tts"]').click(); }
                }
            },
            setStatus: setStatus,
        },
        getCurrentModelId: getCurrentModelId,
    };
    
    // index.html側に準備完了を通知
    if (window.onAppJsReady) {
        window.onAppJsReady();
    }
})();