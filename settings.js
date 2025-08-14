// =========================================================================
// --- 1. 背景設定、UI設定、データ管理 (IndexedDB版) ---
// =========================================================================

// --- グローバル定数、DOM要素、状態管理変数 ---

const SHOW_ADVANCED_FORMATS = true; 
const FORMAT_MAPPING = { mp3: { contentType: 'audio/mpeg', extension: 'mp3' }, wav: { contentType: 'audio/wav', extension: 'wav' }, flac: { contentType: 'audio/flac', extension: 'flac' }, opus: { contentType: 'audio/ogg', extension: 'opus' } };
// IndexedDB設定
const DB_NAME = 'ttsAppDB';
const DB_VERSION = 1;
const STORES = {
    UI_SETTINGS: 'uiSettings',
    MODEL_PROFILES: 'modelProfiles',
    IMAGES: 'images',
    TEST_POSTS: 'testPosts',
};

// DOM要素取得 (全ファイルで共有)
const modelSelectTTS = document.getElementById('model-select-tts'), modelSelectBG = document.getElementById('model-select-bg'), formatSelect = document.getElementById('format-select');
const generateBtn = document.getElementById('generate-btn'), generatePreviewBtn = document.getElementById('generate-preview-btn');
const textInput = document.getElementById('text'), styleIdInput = document.getElementById('style-id-input');
const styleStrengthInput = document.getElementById('style_strength'), strengthValueSpan = document.getElementById('strength-value');
const statusDiv = document.getElementById('status'), resultsContainer = document.getElementById('results-container');
const combinedResultContainer = document.getElementById('combined-result-container');
const combinedAudioPlayer = document.getElementById('combined-audio-player');
const downloadCombinedBtn = document.getElementById('download-combined-btn');
const combinedPreviewArea = document.getElementById('combined-preview-area');
const combinedPreviewPlayer = document.getElementById('combined-preview-player');
const downloadCombinedPreviewBtn = document.getElementById('download-combined-preview-btn');
const containerWrapper = document.querySelector('.container-wrapper'), bodyElement = document.body;
const containerHeader = document.querySelector('.container-header');
const uiWidthSlider = document.getElementById('ui-width-slider'), uiWidthInput = document.getElementById('ui-width-input');
const uiOpacitySlider = document.getElementById('ui-opacity-slider'), uiOpacityInput = document.getElementById('ui-opacity-input');
const displayNameInput = document.getElementById('display-name-input'), saveDisplayNameBtn = document.getElementById('save-display-name-btn');
const galleryContainer = document.getElementById('gallery-container');
const tabButtons = document.querySelectorAll('.tab-button'), tabContents = document.querySelectorAll('.tab-content');
const resetUiBtn = document.getElementById('reset-ui-btn');
const resetAllBgsBtn = document.getElementById('reset-all-bgs-btn');
const uploadImageBtn = document.getElementById('upload-image-btn'), imageUploadInput = document.getElementById('image-upload-input');
const exportAllSettingsBtn = document.getElementById('export-all-settings-btn');
const bgAdjustToggle = document.getElementById('bg-adjust-toggle');
const bgFadeOverlay = document.getElementById('bg-fade-overlay');
const adjustModeControls = document.getElementById('adjust-mode-controls');
const revertBgChangesBtn = document.getElementById('revert-bg-changes-btn');
const applyBgChangesBtn = document.getElementById('apply-bg-changes-btn');
const resultsPlaceholder = document.getElementById('results-placeholder');
const addFirstCardBtn = document.getElementById('add-first-card-btn');
const saveToR2Btn = document.getElementById('save-to-r2-btn');
const r2GalleryContainer = document.getElementById('r2-gallery-container');
const refreshR2GalleryBtn = document.getElementById('refresh-r2-gallery-btn');
const savePreviewToR2Btn = document.getElementById('save-preview-to-r2-btn');
const r2SearchModelSelect = document.getElementById('r2-search-model-select');
const r2SearchTextInput = document.getElementById('r2-search-text-input');
const r2FilterMineToggle = document.getElementById('r2-filter-mine-toggle');
const r2FilterStatus = document.getElementById('r2-filter-status');
const r2PaginationControls = document.getElementById('r2-pagination-controls');
const r2PrevPageBtn = document.getElementById('r2-prev-page-btn');
const r2NextPageBtn = document.getElementById('r2-next-page-btn');
const r2PageInfo = document.getElementById('r2-page-info');

// 状態管理 (全ファイルで共有)
let appState = { uiSettings: {}, modelProfiles: {} }; // メモリ上のキャッシュ
let resultStates = {}; let originalModels = [];
let currentCombinedAudioBlob = null, currentCombinedAudioInfo = { text: '', filename: '' };
let currentPreviewAudioBlob = null, currentPreviewAudioInfo = { text: '', filename: '' };
const defaultUiSettings = { width: 700, posX: (window.innerWidth - 700) / 2, posY: 32, opacity: 1.0 };
let isAdjustMode = false, tempBgSettings = { pixelX: 0, pixelY: 0, scale: 1.0 };
let isDraggingBg = false, isPanning = false, isPinching = false, lastPinchDist = 0;
let dragStart = { mouseX: 0, mouseY: 0, pixelX: 0, pixelY: 0 };
let panStart = { touchX: 0, touchY: 0, pixelX: 0, pixelY: 0 };
let animationFrameId = null;
const audioContextForDecoding = new (window.AudioContext || window.webkitAudioContext)();

let r2GalleryState = {
    currentPage: 1,
    filter: 'all',
    modelId: '',
    searchText: '',
    userId: '',
    isLoading: false,
    hasNextPage: false
};

// --- IndexedDB ヘルパー ---
const db = (() => {
    let dbInstance = null;
    function init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onerror = (event) => reject(`IndexedDB error: ${event.target.errorCode}`);
            request.onsuccess = (event) => {
                dbInstance = event.target.result;
                resolve(dbInstance);
            };
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORES.UI_SETTINGS)) {
                    db.createObjectStore(STORES.UI_SETTINGS, { keyPath: 'key' });
                }
                if (!db.objectStoreNames.contains(STORES.MODEL_PROFILES)) {
                    db.createObjectStore(STORES.MODEL_PROFILES, { keyPath: 'modelId' });
                }
                if (!db.objectStoreNames.contains(STORES.IMAGES)) {
                    const imageStore = db.createObjectStore(STORES.IMAGES, { keyPath: 'id' });
                    imageStore.createIndex('modelId', 'modelId', { unique: false });
                }
                if (!db.objectStoreNames.contains(STORES.TEST_POSTS)) {
                    const testPostStore = db.createObjectStore(STORES.TEST_POSTS, { keyPath: 'id', autoIncrement: true });
                    testPostStore.createIndex('expiresAt', 'expiresAt', { unique: false });
                }
            };
        });
    }

    async function getDB() {
        if (!dbInstance) {
            dbInstance = await init();
        }
        return dbInstance;
    }

    function requestToPromise(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = (event) => reject(event.target.error);
        });
    }

    return {
        get: async (storeName, key) => requestToPromise((await getDB()).transaction(storeName).objectStore(storeName).get(key)),
        getAll: async (storeName) => requestToPromise((await getDB()).transaction(storeName).objectStore(storeName).getAll()),
        put: async (storeName, value) => requestToPromise((await getDB()).transaction(storeName, 'readwrite').objectStore(storeName).put(value)),
        delete: async (storeName, key) => requestToPromise((await getDB()).transaction(storeName, 'readwrite').objectStore(storeName).delete(key)),
        clear: async (storeName) => requestToPromise((await getDB()).transaction(storeName, 'readwrite').objectStore(storeName).clear()),
        getAllByIndex: async (storeName, indexName, query) => requestToPromise((await getDB()).transaction(storeName).objectStore(storeName).index(indexName).getAll(query)),
        deleteExpired: async (storeName, indexName) => {
            const db = await getDB();
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const index = store.index(indexName);
            const range = IDBKeyRange.upperBound(Date.now());
            const request = index.openCursor(range);
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    store.delete(cursor.primaryKey);
                    cursor.continue();
                }
            };
            return new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onerror = (event) => reject(event.target.error);
            });
        }
    };
})();

// --- 関数群 (IndexedDB対応) ---

async function loadSettings() {
    try {
        const [uiSettings, modelProfiles] = await Promise.all([
            db.getAll(STORES.UI_SETTINGS),
            db.getAll(STORES.MODEL_PROFILES)
        ]);
        
        appState.uiSettings = { ...defaultUiSettings };
        uiSettings.forEach(s => appState.uiSettings[s.key] = s.value);
        
        appState.modelProfiles = {};
        modelProfiles.forEach(p => appState.modelProfiles[p.modelId] = p);

        for (const modelId in appState.modelProfiles) {
            const images = await db.getAllByIndex(STORES.IMAGES, 'modelId', modelId);
            const modelProfile = appState.modelProfiles[modelId];
            modelProfile.images = [];
            for (const img of images) {
                if (img.blob) {
                    img.dataUrl = URL.createObjectURL(img.blob); // BlobからURLを生成
                    modelProfile.images.push(img);
                }
            }
        }
    } catch (error) {
        console.error("Failed to load settings from IndexedDB:", error);
        setStatus("設定の読み込みに失敗しました。", true);
        appState = { uiSettings: { ...defaultUiSettings }, modelProfiles: {} };
    }
}

const saveUiSetting = async (key, value) => { appState.uiSettings[key] = value; await db.put(STORES.UI_SETTINGS, { key, value }); };
const saveModelProfile = async (profile) => { const {images, ...profileToSave} = profile; await db.put(STORES.MODEL_PROFILES, profileToSave); };
const saveImage = async (image) => { if (image.dataUrl) delete image.dataUrl; await db.put(STORES.IMAGES, image); };
const deleteImage = async (id) => await db.delete(STORES.IMAGES, id);

const getModelData = (modelId) => {
    if (!appState.modelProfiles[modelId]) {
        const modelName = originalModels.find(m => m.id === modelId)?.name || modelId;
        const newProfile = { modelId: modelId, displayName: modelName, images: [], activeImageId: null };
        appState.modelProfiles[modelId] = newProfile;
        saveModelProfile(newProfile);
    }
    return appState.modelProfiles[modelId];
};
const getActiveImage = (modelId) => modelId ? getModelData(modelId).images.find(img => img.id === getModelData(modelId).activeImageId) : null;
const getCurrentModelId = () => modelSelectTTS.value;
const setStatus = (message, isError = false) => { statusDiv.textContent = message; statusDiv.className = isError ? 'status-error' : 'status-info'; };

const updateSelectOptions = () => {
    [modelSelectTTS, modelSelectBG].forEach(sel => {
        Array.from(sel.options).forEach(opt => {
            if (opt.value && appState.modelProfiles[opt.value]) {
                opt.textContent = appState.modelProfiles[opt.value].displayName;
            }
        });
    });
    const r2Models = [...new Set(originalModels.map(m => m.id))];
    const currentR2Model = r2SearchModelSelect.value;
    r2SearchModelSelect.innerHTML = '<option value="">すべてのモデル</option>';
    r2Models.forEach(id => {
        const displayName = appState.modelProfiles[id]?.displayName || id;
        const option = document.createElement('option');
        option.value = id;
        option.textContent = displayName;
        r2SearchModelSelect.appendChild(option);
    });
    r2SearchModelSelect.value = currentR2Model;
};

const applyUiSettings = () => {
    const { width, posX, posY, opacity } = appState.uiSettings;
    containerWrapper.style.maxWidth = `${width}px`;
    containerWrapper.style.left = `${posX}px`;
    containerWrapper.style.top = `${posY}px`;
    containerWrapper.style.opacity = opacity;
    uiWidthSlider.value = width;
    uiWidthInput.value = width;
    uiOpacitySlider.value = opacity;
    uiOpacityInput.value = opacity;
};

const applyBackground = (image) => {
    if (image && image.dataUrl) {
        bodyElement.style.backgroundImage = `url(${image.dataUrl})`;
        bodyElement.style.backgroundSize = `${100 * (image.scale || 1.0)}%`;
        bodyElement.style.backgroundPosition = `${image.pixelX || 0}px ${image.pixelY || 0}px`;
    } else {
        bodyElement.style.backgroundImage = 'none';
    }
};

const renderGallery = (modelId) => {
    const modelData = getModelData(modelId);
    galleryContainer.innerHTML = '';
    modelData.images.forEach(img => {
        const item = document.createElement('div');
        item.className = 'gallery-item';
        if (img.id === modelData.activeImageId) item.classList.add('active-bg');
        item.dataset.imageId = img.id;
        item.innerHTML = `<button class="btn-delete-img" title="この画像を削除">×</button><img src="${img.dataUrl}" alt="thumbnail"><p class="gallery-item-name">${img.name}</p>`;
        galleryContainer.appendChild(item);
    });
};

const renderUIForSelectedModel = () => {
    const modelId = getCurrentModelId();
    if (!modelId) return;
    displayNameInput.value = getModelData(modelId).displayName;
    const activeImage = getActiveImage(modelId);
    applyBackground(activeImage);
    renderGallery(modelId);
    if (isAdjustMode) {
        endBgAdjustMode({ revert: true });
    }
    document.getElementById('image-adjust-panel').style.display = activeImage ? 'block' : 'none';
};

const createImageName = (image) => `${image.name.split('_')[0]}_${Math.round(image.pixelX)}_${Math.round(image.pixelY)}_${image.scale.toFixed(2)}.${image.extension}`;

const handleFile = (file) => {
    if (file.type.startsWith('image/')) {
        importImage(file);
    } else if (file.type === 'application/zip' || file.type === 'application/x-zip-compressed' || file.name.endsWith('.zip')) {
        importZip(file);
    } else {
        setStatus('画像またはZIPファイルを選択してください。', true);
    }
};

const importImage = async (file) => {
    const modelId = getCurrentModelId();
    if (!modelId) {
        setStatus('先に音声モデルを選択してください。', true);
        return;
    }
    const modelData = getModelData(modelId);
    const count = (modelData.images.length > 0 ? Math.max(...modelData.images.map(img => parseInt(img.name.split('_')[0]))) : 0) + 1;
    const w = window.innerWidth, h = window.innerHeight, scale = 1.0;
    const imgW = w * scale, imgH = h * scale;
    const newImage = {
        id: Date.now(),
        modelId: modelId,
        blob: file, // Blobを直接保存
        pixelX: (w - imgW) / 2,
        pixelY: (h - imgH) / 2,
        scale: 1.0,
        extension: file.name.split('.').pop() || 'png'
    };
    newImage.name = createImageName(newImage);
    
    await saveImage(newImage);
    newImage.dataUrl = URL.createObjectURL(newImage.blob);
    modelData.images.push(newImage);
    modelData.activeImageId = newImage.id;
    await saveModelProfile(modelData);

    performFadeSwitch(() => renderUIForSelectedModel());
    setStatus(`画像「${newImage.name}」を背景に設定しました。`);
};

const exportAllSettings = async () => {
    setStatus('設定をエクスポート中...');
    try {
        const zip = new JSZip();
        const profiles = await db.getAll(STORES.MODEL_PROFILES);
        const images = await db.getAll(STORES.IMAGES);
        
        const stateToExport = { uiSettings: appState.uiSettings, modelProfiles: {} };

        for (const profile of profiles) {
            stateToExport.modelProfiles[profile.modelId] = { ...profile, images: [] };
        }

        for (const image of images) {
            if (image.blob && stateToExport.modelProfiles[image.modelId]) {
                const base64Data = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result.split(',')[1]);
                    reader.onerror = reject;
                    reader.readAsDataURL(image.blob);
                });
                const extension = image.extension || 'png';
                const imagePath = `images/${image.modelId}_${image.id}.${extension}`;
                zip.file(imagePath, base64Data, { base64: true });
                
                const imageMetadata = { ...image };
                delete imageMetadata.blob;
                imageMetadata.dataUrl = imagePath; // export用パス
                stateToExport.modelProfiles[image.modelId].images.push(imageMetadata);
            }
        }
        zip.file("settings.json", JSON.stringify(stateToExport, null, 2));
        const blob = await zip.generateAsync({ type: "blob" });
        const date = new Date().toISOString().slice(0, 10);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `tts-settings-backup-${date}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
        setStatus('設定のエクスポートが完了しました。');
    } catch (error) {
        console.error("エクスポートエラー:", error);
        setStatus(`エクスポートに失敗しました: ${error.message}`, true);
    }
};

const importZip = async (file) => {
    if (!confirm('現在の設定をすべて上書きしてインポートします。よろしいですか？')) return;
    setStatus('設定をインポート中...');
    try {
        const zip = await JSZip.loadAsync(file);
        const settingsFile = zip.file("settings.json");
        if (!settingsFile) throw new Error("ZIP内にsettings.jsonが見つかりません。");
        
        const settingsJson = await settingsFile.async("string");
        const importedState = JSON.parse(settingsJson);

        await Promise.all([
            db.clear(STORES.UI_SETTINGS),
            db.clear(STORES.MODEL_PROFILES),
            db.clear(STORES.IMAGES)
        ]);

        for(const key in importedState.uiSettings) {
            await db.put(STORES.UI_SETTINGS, { key, value: importedState.uiSettings[key] });
        }

        for (const modelId in importedState.modelProfiles) {
            const profile = importedState.modelProfiles[modelId];
            for (const imageMetadata of profile.images) {
                if (typeof imageMetadata.dataUrl === 'string' && imageMetadata.dataUrl.startsWith('images/')) {
                    const imageFile = zip.file(imageMetadata.dataUrl);
                    if (imageFile) {
                        const blob = await imageFile.async("blob");
                        const newImage = { ...imageMetadata, blob, modelId };
                        delete newImage.dataUrl;
                        await db.put(STORES.IMAGES, newImage);
                    }
                }
            }
            const { images, ...profileToSave } = profile;
            await db.put(STORES.MODEL_PROFILES, profileToSave);
        }
        
        alert('インポートが完了しました。ページをリロードします。');
        location.reload();
    } catch (error) {
        console.error("インポートエラー:", error);
        setStatus(`インポートに失敗しました: ${error.message}`, true);
    }
};

function renderLoop() {
    bodyElement.style.backgroundSize = `${100 * tempBgSettings.scale}%`;
    bodyElement.style.backgroundPosition = `${tempBgSettings.pixelX}px ${tempBgSettings.pixelY}px`;
    if (isAdjustMode) {
        animationFrameId = requestAnimationFrame(renderLoop);
    }
}
function onBgMouseDown(e) { isDraggingBg = true; dragStart = { mouseX: e.clientX, mouseY: e.clientY, pixelX: tempBgSettings.pixelX, pixelY: tempBgSettings.pixelY }; bodyElement.classList.add('grabbing'); }
function onBgMouseUp() { isDraggingBg = false; bodyElement.classList.remove('grabbing'); }
function onBgMouseMove(e) { if (!isDraggingBg) return; const dx = e.clientX - dragStart.mouseX; const dy = e.clientY - dragStart.mouseY; tempBgSettings.pixelX = dragStart.pixelX + dx; tempBgSettings.pixelY = dragStart.pixelY + dy; }
function onBgWheel(e) { e.preventDefault(); const oldScale = tempBgSettings.scale; const scaleAmount = -e.deltaY * 0.001 * oldScale; const newScale = Math.max(0.1, Math.min(oldScale + scaleAmount, 10)); tempBgSettings.scale = newScale; const cursorX = e.clientX; const cursorY = e.clientY; tempBgSettings.pixelX = cursorX - (cursorX - tempBgSettings.pixelX) * (newScale / oldScale); tempBgSettings.pixelY = cursorY - (cursorY - tempBgSettings.pixelY) * (newScale / oldScale); }
function getDistance(t1, t2) { return Math.sqrt(Math.pow(t1.clientX - t2.clientX, 2) + Math.pow(t1.clientY - t2.clientY, 2)); }
function onBgTouchStart(e) { if (e.touches.length === 1) { isPanning = true; panStart = { touchX: e.touches[0].clientX, touchY: e.touches[0].clientY, pixelX: tempBgSettings.pixelX, pixelY: tempBgSettings.pixelY }; } if (e.touches.length === 2) { isPinching = true; isPanning = false; lastPinchDist = getDistance(e.touches[0], e.touches[1]); } }
function onBgTouchMove(e) { e.preventDefault(); if (isPanning && e.touches.length === 1) { const dx = e.touches[0].clientX - panStart.touchX; const dy = e.touches[0].clientY - panStart.touchY; tempBgSettings.pixelX = panStart.pixelX + dx; tempBgSettings.pixelY = panStart.pixelY + dy; } if (isPinching && e.touches.length === 2) { const oldScale = tempBgSettings.scale; const newDist = getDistance(e.touches[0], e.touches[1]); const newScale = Math.max(0.1, Math.min(oldScale * (newDist / lastPinchDist), 10)); tempBgSettings.scale = newScale; const cursorX = (e.touches[0].clientX + e.touches[1].clientX) / 2; const cursorY = (e.touches[0].clientY + e.touches[1].clientY) / 2; tempBgSettings.pixelX = cursorX - (cursorX - tempBgSettings.pixelX) * (newScale / oldScale); tempBgSettings.pixelY = cursorY - (cursorY - tempBgSettings.pixelY) * (newScale / oldScale); lastPinchDist = newDist; } }
function onBgTouchEnd(e) { if (e.touches.length < 2) isPinching = false; if (e.touches.length < 1) isPanning = false; }
const bgEventListeners = { mousedown: onBgMouseDown, mouseup: onBgMouseUp, mousemove: onBgMouseMove, wheel: onBgWheel, touchstart: onBgTouchStart, touchend: onBgTouchEnd, touchmove: onBgTouchMove };

function startBgAdjustMode() {
    const activeImage = getActiveImage(getCurrentModelId());
    if (!activeImage) {
        bgAdjustToggle.checked = false;
        return;
    }
    isAdjustMode = true;
    tempBgSettings.pixelX = activeImage.pixelX || 0;
    tempBgSettings.pixelY = activeImage.pixelY || 0;
    tempBgSettings.scale = activeImage.scale || 1.0;
    bodyElement.classList.add('bg-adjust-mode', 'no-transition');
    setTimeout(() => bodyElement.classList.remove('no-transition'), 50);
    adjustModeControls.style.display = 'flex';
    for (const [event, handler] of Object.entries(bgEventListeners)) {
        window.addEventListener(event, handler, { passive: false });
    }
    animationFrameId = requestAnimationFrame(renderLoop);
}

function endBgAdjustMode({ revert = false } = {}) {
    cancelAnimationFrame(animationFrameId);
    isAdjustMode = false;
    bgAdjustToggle.checked = false;
    bodyElement.classList.remove('bg-adjust-mode');
    adjustModeControls.style.display = 'none';
    for (const [event, handler] of Object.entries(bgEventListeners)) {
        window.removeEventListener(event, handler);
    }
    if (revert) {
        applyBackground(getActiveImage(getCurrentModelId()));
    }
}

function performFadeSwitch(updateAction) {
    const oldStyle = window.getComputedStyle(bodyElement);
    bgFadeOverlay.style.transition = 'none';
    bgFadeOverlay.style.backgroundImage = oldStyle.backgroundImage;
    bgFadeOverlay.style.backgroundSize = oldStyle.backgroundSize;
    bgFadeOverlay.style.backgroundPosition = oldStyle.backgroundPosition;
    bgFadeOverlay.style.opacity = '1';
    bgFadeOverlay.style.zIndex = -1;
    requestAnimationFrame(() => {
        bodyElement.classList.add('no-transition');
        updateAction();
        requestAnimationFrame(() => {
            bodyElement.classList.remove('no-transition');
            bgFadeOverlay.style.zIndex = 1;
            bgFadeOverlay.style.transition = 'opacity 0.5s ease-in-out';
            bgFadeOverlay.style.opacity = '0';
        });
    });
}

const updateFormatSelectVisibility = () => {
    const opusOption = document.querySelector('#format-select option[value="opus"]');
    const flacOption = document.querySelector('#format-select option[value="flac"]');
    if(flacOption) flacOption.style.display = 'none'; // FLACは内部変換用
    if(opusOption) opusOption.style.display = SHOW_ADVANCED_FORMATS ? '' : 'none';
    if (formatSelect.value === 'flac') {
        formatSelect.value = 'mp3';
    }
}

// イベントリスナー設定関数
function setupSettingsEventListeners() {
    tabButtons.forEach(button => button.addEventListener('click', () => { 
        bodyElement.classList.add('no-transition'); 
        tabButtons.forEach(btn => btn.classList.remove('active')); 
        tabContents.forEach(content => content.classList.remove('active')); 
        button.classList.add('active'); 
        const activeTab = document.getElementById(`tab-${button.dataset.tab}`);
        activeTab.classList.add('active'); 
        if (button.dataset.tab === 'r2-gallery' && !button.classList.contains('locked-feature')) {
            r2GalleryState.currentPage = 1;
            loadR2Gallery();
        }
        if (isAdjustMode) { endBgAdjustMode({ revert: true }); } 
        setTimeout(() => bodyElement.classList.remove('no-transition'), 50); 
    }));

    const uiSettingsMap = [ { slider: uiWidthSlider, input: uiWidthInput, key: 'width' }, { slider: uiOpacitySlider, input: uiOpacityInput, key: 'opacity' } ];
    uiSettingsMap.forEach(({ slider, input, key }) => {
        const handler = e => { saveUiSetting(key, e.target.value); applyUiSettings(); };
        slider.addEventListener('input', e => { input.value = e.target.value; handler(e); });
        input.addEventListener('input', e => { slider.value = e.target.value; handler(e); });
    });

    resetUiBtn.addEventListener('click', async () => {
        if (confirm('現在のUI設定（横幅、透過度、位置）をすべてデフォルトに戻します。よろしいですか？')) {
            const defaultWidth = 700;
            appState.uiSettings = { ...defaultUiSettings, width: defaultWidth, posX: (window.innerWidth - defaultWidth) / 2 };
            await db.clear(STORES.UI_SETTINGS);
            for(const key in appState.uiSettings) {
                await db.put(STORES.UI_SETTINGS, { key, value: appState.uiSettings[key] });
            }
            applyUiSettings();
            setStatus('UI設定をリセットしました。');
        }
    });

    let isDragging = false, initialMouseX, initialMouseY, initialUiPosX, initialUiPosY;
    containerHeader.addEventListener('mousedown', e => {
        if (e.target.closest('.tab-button')) return;
        isDragging = true;
        bodyElement.classList.add('ui-dragging');
        containerWrapper.style.transition = 'none';
        initialMouseX = e.clientX;
        initialMouseY = e.clientY;
        initialUiPosX = containerWrapper.offsetLeft;
        initialUiPosY = containerWrapper.offsetTop;
        e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
        if (!isDragging) return;
        let newPosX = initialUiPosX + (e.clientX - initialMouseX);
        let newPosY = initialUiPosY + (e.clientY - initialMouseY);
        newPosX = Math.max(0, Math.min(window.innerWidth - containerWrapper.offsetWidth, newPosX));
        newPosY = Math.max(0, Math.min(window.innerHeight - containerWrapper.offsetHeight, newPosY));
        containerWrapper.style.left = `${newPosX}px`;
        containerWrapper.style.top = `${newPosY}px`;
    });
    window.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        bodyElement.classList.remove('ui-dragging');
        containerWrapper.style.transition = 'max-width 0.3s, opacity 0.3s, visibility 0.3s, left 0.3s, top 0.3s';
        saveUiSetting('posX', containerWrapper.offsetLeft);
        saveUiSetting('posY', containerWrapper.offsetTop);
    });

    resetAllBgsBtn.addEventListener('click', async () => {
        const confirmationText = "背景リセット";
        const userInput = prompt(`この操作は元に戻せません。\n全てのモデルの表示名と背景画像が削除されます。\n\nリセットを実行するには「${confirmationText}」と入力してください。`);
        if (userInput === confirmationText) {
            await Promise.all([
                db.clear(STORES.MODEL_PROFILES),
                db.clear(STORES.IMAGES)
            ]);
            alert('すべての背景設定がリセットされました。ページをリロードします。');
            location.reload();
        } else if (userInput !== null) {
            alert('入力が一致しませんでした。リセットはキャンセルされました。');
        }
    });

    [modelSelectTTS, modelSelectBG].forEach(sel => sel.addEventListener('change', (e) => {
        const newModelId = e.target.value;
        modelSelectTTS.value = newModelId;
        modelSelectBG.value = newModelId;
        performFadeSwitch(() => renderUIForSelectedModel());
    }));

    saveDisplayNameBtn.addEventListener('click', async () => {
        const modelId = getCurrentModelId();
        if (modelId) {
            const profile = getModelData(modelId);
            profile.displayName = displayNameInput.value.trim();
            await saveModelProfile(profile);
            updateSelectOptions();
        }
    });

    bodyElement.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); if (!isAdjustMode) bodyElement.classList.add('drag-over'); });
    bodyElement.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); bodyElement.classList.remove('drag-over'); });
    bodyElement.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); bodyElement.classList.remove('drag-over'); if (e.dataTransfer.files.length > 0) { handleFile(e.dataTransfer.files[0]); } });
    
    uploadImageBtn.addEventListener('click', () => imageUploadInput.click());
    imageUploadInput.addEventListener('change', (e) => { if (e.target.files.length > 0) { handleFile(e.target.files[0]); } e.target.value = null; });
    
    galleryContainer.addEventListener('click', async (e) => {
        const item = e.target.closest('.gallery-item');
        if (!item) return;
        const modelId = getCurrentModelId(), imageId = Number(item.dataset.imageId), modelData = getModelData(modelId);
        if (e.target.classList.contains('btn-delete-img')) {
            if (confirm(`画像「${modelData.images.find(img => img.id === imageId).name}」を削除しますか？`)) {
                if (modelData.activeImageId === imageId) {
                    modelData.activeImageId = null;
                    await saveModelProfile(modelData);
                    performFadeSwitch(() => applyBackground(null));
                    if (isAdjustMode) endBgAdjustMode();
                    document.getElementById('image-adjust-panel').style.display = 'none';
                }
                modelData.images = modelData.images.filter(img => img.id !== imageId);
                await deleteImage(imageId);
                renderGallery(modelId);
            }
        } else if (e.target.tagName === 'IMG') {
            modelData.activeImageId = imageId;
            await saveModelProfile(modelData);
            performFadeSwitch(() => renderUIForSelectedModel());
        }
    });

    bgAdjustToggle.addEventListener('change', () => { bgAdjustToggle.checked ? startBgAdjustMode() : endBgAdjustMode({ revert: true }); });
    revertBgChangesBtn.addEventListener('click', () => endBgAdjustMode({ revert: true }));
    applyBgChangesBtn.addEventListener('click', async () => {
        const activeImage = getActiveImage(getCurrentModelId());
        if (activeImage) {
            activeImage.pixelX = tempBgSettings.pixelX;
            activeImage.pixelY = tempBgSettings.pixelY;
            activeImage.scale = tempBgSettings.scale;
            activeImage.name = createImageName(activeImage);
            await saveImage(activeImage);
            renderGallery(getCurrentModelId());
            applyBackground(activeImage);
            setStatus('背景設定を適用しました。');
        }
        endBgAdjustMode();
    });

    exportAllSettingsBtn.addEventListener('click', exportAllSettings);
}