const SHOW_ADVANCED_FORMATS = true; 
        
// --- 基本設定 & DOM要素取得 (R2関連を除く) ---
const FORMAT_MAPPING = { mp3: { contentType: 'audio/mpeg', extension: 'mp3' }, wav: { contentType: 'audio/wav', extension: 'wav' }, flac: { contentType: 'audio/flac', extension: 'flac' }, opus: { contentType: 'audio/ogg', extension: 'opus' } };
const STORAGE_KEY = 'ttsAppStorage_v14';
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
const savePreviewToR2Btn = document.getElementById('save-preview-to-r2-btn');

// --- 状態管理 ---
let appState = {}; let resultStates = {}; let originalModels = [];
// HTML側のR2スクリプトから参照されるグローバル変数
let currentCombinedAudioBlob = null;
let currentCombinedAudioFilename = '';
let currentPreviewAudioBlob = null;
let currentPreviewAudioFilename = '';
const defaultUiSettings = { width: 700, posX: (window.innerWidth - 700) / 2, posY: 32, opacity: 1.0 };
let isAdjustMode = false; let tempBgSettings = { pixelX: 0, pixelY: 0, scale: 1.0 };
let isDraggingBg = false; let isPanning = false, isPinching = false, lastPinchDist = 0;
let dragStart = { mouseX: 0, mouseY: 0, pixelX: 0, pixelY: 0 };
let panStart = { touchX: 0, touchY: 0, pixelX: 0, pixelY: 0 };
let animationFrameId = null;
const audioContextForDecoding = new (window.AudioContext || window.webkitAudioContext)();

const loadState = () => { const savedState = localStorage.getItem(STORAGE_KEY); appState = savedState ? JSON.parse(savedState) : {}; appState.uiSettings = { ...defaultUiSettings, ...(appState.uiSettings || {}) }; };
const saveState = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
// HTML側のR2スクリプトから参照されるグローバル関数
const getModelData = (modelId) => { if (!appState[modelId]) { const modelName = originalModels.find(m => m.id === modelId)?.name || modelId; appState[modelId] = { displayName: modelName, images: [], activeImageId: null }; } return appState[modelId]; };
const getActiveImage = (modelId) => modelId ? getModelData(modelId).images.find(img => img.id === getModelData(modelId).activeImageId) : null;
const getCurrentModelId = () => modelSelectTTS.value;

// --- UI更新関数 ---
// HTML側のR2スクリプトから参照されるグローバル関数
const setStatus = (message, isError = false) => { statusDiv.textContent = message; statusDiv.className = isError ? 'status-error' : 'status-info'; };
const updateSelectOptions = () => { [modelSelectTTS, modelSelectBG].forEach(sel => Array.from(sel.options).forEach(opt => { opt.textContent = getModelData(opt.value).displayName; })); };
const applyUiSettings = () => { const { width, posX, posY, opacity } = appState.uiSettings; containerWrapper.style.maxWidth = `${width}px`; containerWrapper.style.left = `${posX}px`; containerWrapper.style.top = `${posY}px`; containerWrapper.style.opacity = opacity; uiWidthSlider.value = width; uiWidthInput.value = width; uiOpacitySlider.value = opacity; uiOpacityInput.value = opacity; };
const applyBackground = (image) => { if (image && image.dataUrl) { bodyElement.style.backgroundImage = `url(${image.dataUrl})`; bodyElement.style.backgroundSize = `${100 * (image.scale || 1.0)}%`; bodyElement.style.backgroundPosition = `${image.pixelX || 0}px ${image.pixelY || 0}px`; } else { bodyElement.style.backgroundImage = 'none'; } };
const renderGallery = (modelId) => { const modelData = getModelData(modelId); galleryContainer.innerHTML = ''; modelData.images.forEach(img => { const item = document.createElement('div'); item.className = 'gallery-item'; if (img.id === modelData.activeImageId) item.classList.add('active-bg'); item.dataset.imageId = img.id; item.innerHTML = `<button class="btn-delete-img" title="この画像を削除">×</button><img src="${img.dataUrl}" alt="thumbnail"><p class="gallery-item-name">${img.name}</p>`; galleryContainer.appendChild(item); }); };
const renderUIForSelectedModel = () => { const modelId = getCurrentModelId(); if (!modelId) return; displayNameInput.value = getModelData(modelId).displayName; const activeImage = getActiveImage(modelId); applyBackground(activeImage); renderGallery(modelId); if (isAdjustMode) { endBgAdjustMode({ revert: true }); } document.getElementById('image-adjust-panel').style.display = activeImage ? 'block' : 'none'; };
const createImageName = (image) => `${image.name.split('_')[0]}_${Math.round(image.pixelX)}_${Math.round(image.pixelY)}_${image.scale.toFixed(2)}.${image.extension}`;

// --- ファイル処理 (画像/ZIP) ---
const handleFile = (file) => { if (file.type.startsWith('image/')) { importImage(file); } else if (file.type === 'application/zip' || file.type === 'application/x-zip-compressed' || file.name.endsWith('.zip')) { importZip(file); } else { setStatus('画像またはZIPファイルを選択してください。', true); } };
const importImage = (file) => { const modelId = getCurrentModelId(); if (!modelId) { setStatus('先に音声モデルを選択してください。', true); return; } const reader = new FileReader(); reader.onload = (event) => { const modelData = getModelData(modelId); const count = (modelData.images.length > 0 ? Math.max(...modelData.images.map(img => parseInt(img.name.split('_')[0]))) : 0) + 1; const w = window.innerWidth, h = window.innerHeight, scale = 1.0; const imgW = w * scale, imgH = h * scale; const newImage = { id: Date.now(), dataUrl: event.target.result, pixelX: (w - imgW) / 2, pixelY: (h - imgH) / 2, scale: 1.0, extension: file.name.split('.').pop() || 'png' }; newImage.name = createImageName(newImage); modelData.images.push(newImage); modelData.activeImageId = newImage.id; saveState(); performFadeSwitch(() => renderUIForSelectedModel()); setStatus(`画像「${newImage.name}」を背景に設定しました。`); }; reader.readAsDataURL(file); };

// --- 無音データ生成 & 音声結合 ---
function createSilence(durationSeconds, format, sampleRate = 44100, channels = 1, bitDepth = 16) {
    if (format === 'wav') {
        const bytesPerSample = bitDepth / 8;
        const blockAlign = channels * bytesPerSample;
        const numSamples = Math.round(sampleRate * durationSeconds);
        const dataSize = numSamples * blockAlign;
        const buffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(buffer);
        view.setUint32(0, 0x52494646, false); // "RIFF"
        view.setUint32(4, 36 + dataSize, true);
        view.setUint32(8, 0x57415645, false); // "WAVE"
        view.setUint32(12, 0x666d7420, false); // "fmt "
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); // PCM
        view.setUint16(22, channels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * blockAlign, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitDepth, true);
        view.setUint32(36, 0x64617461, false); // "data"
        view.setUint32(40, dataSize, true);
        const blob = new Blob([buffer], { type: 'audio/wav' });
        blob.isSilence = true;
        return blob;
    } else if (format === 'mp3') {
        const silentFrame = new Uint8Array([0xff, 0xfb, 0x10, 0xc4, 0x00, 0x00, 0x00, 0x03, 0x48, 0x00, 0x00, 0x00, 0x00, 0x4c, 0x41, 0x4d, 0x45, 0x33, 0x2e, 0x31, 0x30, 0x30]);
        const frameDuration = 1152 / 44100;
        const numFrames = Math.ceil(durationSeconds / frameDuration);
        const silentFrames = [];
        for (let i = 0; i < numFrames; i++) {
            silentFrames.push(silentFrame);
        }
        const blob = new Blob(silentFrames, { type: 'audio/mpeg' });
        blob.isSilence = true;
        return blob;
    }
    return null;
}

function findDataChunk(view) {
    let offset = 12;
    const byteLength = view.byteLength;
    while (offset < byteLength) {
        if (offset + 8 > byteLength) break;
        const chunkId = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
        let chunkSize = view.getUint32(offset + 4, true);
        if (chunkId === 'data') {
            if (offset + 8 + chunkSize > byteLength) {
                console.warn("WAV data chunk size is larger than file. Using remaining bytes.");
                chunkSize = byteLength - (offset + 8);
            }
            return { offset: offset + 8, size: chunkSize };
        }
        offset += 8 + chunkSize;
        if (chunkSize % 2 !== 0) {
            offset += 1;
        }
    }
    console.error('Could not find "data" chunk in WAV file.');
    return null;
}

const mergeWavBlobs = async (blobs) => {
    const audioDataParts = [];
    let sampleRate, channels, bitDepth;
    let totalDataSize = 0;

    for (const blob of blobs) {
        if (blob.size < 44) {
            if(blob.size > 0) console.warn("Skipping a blob that is too small to be a valid WAV file.");
            continue;
        }
        const buffer = await blob.arrayBuffer();
        const view = new DataView(buffer);

        if (!sampleRate) {
            sampleRate = view.getUint32(24, true);
            channels = view.getUint16(22, true);
            bitDepth = view.getUint16(34, true);
        }

        const dataChunk = findDataChunk(view);
        if (dataChunk && dataChunk.size > 0) {
            const audioData = new Uint8Array(buffer, dataChunk.offset, dataChunk.size);
            audioDataParts.push(audioData);
            totalDataSize += dataChunk.size;
        }
    }

    if (totalDataSize === 0) return null;

    const bytesPerSample = bitDepth / 8;
    const blockAlign = channels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    
    const headerBuffer = new ArrayBuffer(44);
    const headerView = new DataView(headerBuffer);

    headerView.setUint32(0, 0x52494646, false); // "RIFF"
    headerView.setUint32(4, 36 + totalDataSize, true);
    headerView.setUint32(8, 0x57415645, false); // "WAVE"
    headerView.setUint32(12, 0x666d7420, false); // "fmt "
    headerView.setUint32(16, 16, true);
    headerView.setUint16(20, 1, true); // PCM
    headerView.setUint16(22, channels, true);
    headerView.setUint32(24, sampleRate, true);
    headerView.setUint32(28, byteRate, true);
    headerView.setUint16(32, blockAlign, true);
    headerView.setUint16(34, bitDepth, true);
    headerView.setUint32(36, 0x64617461, false); // "data"
    headerView.setUint32(40, totalDataSize, true);

    const combinedBlobParts = [new Uint8Array(headerBuffer), ...audioDataParts];
    return new Blob(combinedBlobParts, { type: 'audio/wav' });
};

const combineAudioBlobs = async (blobs, intervals) => {
    if (!blobs || blobs.length === 0) return null;
    const combinedParts = [];
    const format = formatSelect.value === 'wav' ? 'wav' : blobs[0].type.split('/')[1];
    for (let i = 0; i < blobs.length; i++) {
        combinedParts.push(blobs[i]);
        if (i < intervals.length && intervals[i] > 0) {
            const silence = createSilence(intervals[i], format === 'mp3' ? 'mp3' : 'wav');
            if (silence) combinedParts.push(silence);
        }
    }
    if (format === 'mp3') return await mergeMp3Blobs(combinedParts);
    if (format === 'wav') return await mergeWavBlobs(combinedParts);
    return new Blob(combinedParts, { type: FORMAT_MAPPING[format]?.contentType || blobs[0].type });
};

const mergeMp3Blobs = async (blobs) => {
    const processedBuffers = [];
    for (let i = 0; i < blobs.length; i++) {
        const blob = blobs[i];
        const buffer = new Uint8Array(await blob.arrayBuffer());
        if (buffer.length === 0) continue;
        if (blob.isSilence) {
            processedBuffers.push(buffer);
            continue;
        }
        let offset = 0;
        if (i > 0) {
            const view = new DataView(buffer.buffer);
            if (buffer.length > 10 && view.getUint32(0, false) >> 8 === 0x494433) { // 'ID3'
                const size = (view.getUint8(6) << 21) | (view.getUint8(7) << 14) | (view.getUint8(8) << 7) | view.getUint8(9);
                offset = 10 + size;
            }
        }
        let end = buffer.length;
        if (i < blobs.length - 1) {
            const view = new DataView(buffer.buffer);
            if (buffer.length > 128 && view.getUint32(buffer.length - 128, false) >> 8 === 0x544147) { // 'TAG'
                end -= 128;
            }
        }
        processedBuffers.push(buffer.slice(offset, end));
    }
    return new Blob(processedBuffers, { type: 'audio/mpeg' });
};

const getFormatConfigByContentType = (contentType) => { if (!contentType) return { extension: 'bin', contentType: 'application/octet-stream' }; return Object.values(FORMAT_MAPPING).find(config => config.contentType === contentType.split(';')[0].trim()) || { extension: 'bin', contentType }; };
const base64ToBlob = (base64, contentType) => { const byteCharacters = atob(base64); const byteArrays = []; for (let offset = 0; offset < byteCharacters.length; offset += 512) { const slice = byteCharacters.slice(offset, offset + 512); const byteNumbers = new Array(slice.length); for (let i = 0; i < slice.length; i++) byteNumbers[i] = slice.charCodeAt(i); byteArrays.push(new Uint8Array(byteNumbers)); } return new Blob(byteArrays, { type: contentType }); };
async function processServerResponseAudio(base64Data, contentType) {
    const rawBlob = base64ToBlob(base64Data, contentType);
    if (formatSelect.value === 'wav' && (contentType.includes('flac') || contentType.includes('x-flac'))) {
        try {
            const arrayBuffer = await rawBlob.arrayBuffer();
            const audioBuffer = await audioContextForDecoding.decodeAudioData(arrayBuffer);
            return audioBufferToWav(audioBuffer);
        } catch (error) {
            console.error('FLAC to WAV decoding failed:', error);
            throw new Error('FLACからWAVへの変換に失敗しました。');
        }
    }
    return rawBlob;
}
const createSafeFileName = (modelId, text, extension) => {
    const date = new Date();
    const timestamp = `${date.getFullYear()}${(date.getMonth() + 1).toString().padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}-${date.getHours().toString().padStart(2, '0')}${date.getMinutes().toString().padStart(2, '0')}${date.getSeconds().toString().padStart(2, '0')}`;
    const cleanModelId = (modelId || 'UnknownModelId').replace(/[\\/:*?"<>|]/g, '_').trim();
    const cleanText = (text || 'NoText').substring(0, 30).replace(/[\\/:*?"<>|]/g, '_').trim();
    return `${timestamp}_${cleanModelId}_${cleanText}.${extension}`;
}
const validateInput = (lines) => { const errors = []; if (lines.length > 10) errors.push(`最大10行までです。`); if (lines.some(line => line.length > 50)) errors.push(`1行あたり最大50文字までです。`); if (styleIdInput.value === '' || isNaN(parseInt(styleIdInput.value, 10))) errors.push('スタイルIDは数字で入力してください。'); if (errors.length > 0) { setStatus(errors.join(' / '), true); return false; } return true; };

const processAudioRequest = async (linesToProcess) => {
    if (!validateInput(linesToProcess)) return null;
    generateBtn.disabled = true; generatePreviewBtn.disabled = true;
    setStatus(`${linesToProcess.length}件の音声を生成中...`);
    try {
        const requestFormat = formatSelect.value === 'wav' ? 'flac' : formatSelect.value;
        const response = await fetch('/synthesize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model_id: getCurrentModelId(), texts: linesToProcess, style_id: styleIdInput.value, style_strength: parseFloat(styleStrengthInput.value), format: requestFormat }) });
        if (!response.ok) throw new Error(`APIエラー (${response.status}): ${await response.text()}`);
        return await response.json();
    } catch (error) { setStatus(error.message, true); return null; } finally { generateBtn.disabled = false; updateAllCardUIs(); }
};

const addHistoryEntry = (cardId, newEntry) => { const state = resultStates[cardId]; if (!state) return; state.history.splice(state.currentIndex + 1); state.history.push(newEntry); state.currentIndex = state.history.length - 1; };
const updateCardUI = (cardId) => { const state = resultStates[cardId]; if (!state) return; const card = document.querySelector(`[data-card-id="${cardId}"]`); if (!card) return; const audio = card.querySelector('audio'); const downloadLink = card.querySelector('.download-link'); const undoBtn = card.querySelector('.btn-undo'); const redoBtn = card.querySelector('.btn-redo'); const errorMessageDiv = card.querySelector('.error-message'); const editableText = card.querySelector('.editable-text'); const hasAudio = state.history.length > 0 && state.currentIndex >= 0; const isTrueError = !!state.error; card.classList.toggle('is-error', isTrueError); audio.style.display = hasAudio ? 'block' : 'none'; downloadLink.style.display = hasAudio ? 'flex' : 'none'; undoBtn.style.display = hasAudio ? 'flex' : 'none'; redoBtn.style.display = hasAudio ? 'flex' : 'none'; errorMessageDiv.style.display = !hasAudio ? 'block' : 'none'; if (!hasAudio) { if (isTrueError) { errorMessageDiv.textContent = `エラー: ${state.error}`; errorMessageDiv.style.color = ''; } else { errorMessageDiv.textContent = 'テキストを入力し、再生成ボタン(↻)を押してください。'; errorMessageDiv.style.color = '#6c757d'; } editableText.textContent = state.initialText; } else { const currentHistoryEntry = state.history[state.currentIndex]; editableText.textContent = currentHistoryEntry.text; if (state.audioUrl) URL.revokeObjectURL(state.audioUrl); const url = URL.createObjectURL(currentHistoryEntry.blob); state.audioUrl = url; audio.src = url; downloadLink.href = url; const formatConfig = getFormatConfigByContentType(currentHistoryEntry.blob.type); downloadLink.download = createSafeFileName(getCurrentModelId(), currentHistoryEntry.text, formatConfig.extension); } undoBtn.disabled = !hasAudio || state.currentIndex <= 0; redoBtn.disabled = !hasAudio || state.currentIndex >= state.history.length - 1; };

const addResultCard = async (result, insertAfterCard = null) => {
    const cardId = `card-${Date.now()}-${Math.random()}`;
    const card = document.createElement('div'); card.className = 'player-card'; card.dataset.cardId = cardId;
    card.innerHTML = `
        <div class="card-main">
            <div class="card-text-wrapper">
                <span class="card-index"></span>
                <p class="editable-text" contenteditable="true"></p>
            </div>
            <audio controls style="display: none;"></audio>
            <div class="error-message" style="display: none;"></div>
            <div class="card-status"></div>
        </div>
        <div class="card-actions-wrapper">
            <div class="player-actions">
                <button class="icon-btn btn-regenerate" title="再生成">↻</button>
                <button class="icon-btn btn-undo" title="元に戻す">↩</button>
                <button class="icon-btn btn-redo" title="やり直す">↪</button>
                <a class="download-link icon-btn" title="ダウンロード" style="display: none;">📥</a>
                <button class="icon-btn btn-add" title="下に新規追加">⊕</button>
                <button class="icon-btn btn-delete" title="削除">🗑️</button>
            </div>
            <div class="interval-control" style="display: none;">
                <label for="interval-${cardId}">間隔:</label>
                <input type="number" id="interval-${cardId}" class="interval-input" value="0" min="0" step="0.05">
                <span>秒</span>
            </div>
        </div>`;
    if (result.status === 'success') {
        try {
            const audioBlob = await processServerResponseAudio(result.audio_base_64, result.content_type);
            resultStates[cardId] = { initialText: result.text, history: [{ blob: audioBlob, text: result.text }], currentIndex: 0, error: null, audioUrl: null };
        } catch (error) {
            resultStates[cardId] = { initialText: result.text, history: [], currentIndex: -1, error: error.message, audioUrl: null };
        }
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
    resultsPlaceholder.style.display = cards.length > 0 ? 'none' : 'block';
    generatePreviewBtn.disabled = validAudioCount < 1;
};

const exportAllSettings = async () => { setStatus('設定をエクスポート中...'); try { const zip = new JSZip(); const stateToExport = JSON.parse(JSON.stringify(appState)); for (const modelId in stateToExport) { if (modelId === 'uiSettings' || !stateToExport[modelId].images) continue; for (const image of stateToExport[modelId].images) { if (image.dataUrl) { const match = image.dataUrl.match(/data:(image\/\w+);base64,(.*)/); if (match) { const mimeType = match[1]; const base64Data = match[2]; const extension = mimeType.split('/')[1] || 'png'; const imagePath = `images/${modelId}_${image.id}.${extension}`; zip.file(imagePath, base64Data, { base64: true }); image.dataUrl = imagePath; } } } } zip.file("settings.json", JSON.stringify(stateToExport, null, 2)); const blob = await zip.generateAsync({ type: "blob" }); const date = new Date().toISOString().slice(0, 10); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `tts-settings-backup-${date}.zip`; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(a.href); setStatus('設定のエクスポートが完了しました。'); } catch (error) { console.error("エクスポートエラー:", error); setStatus(`エクスポートに失敗しました: ${error.message}`, true); } };
const importZip = async (file) => { if (!confirm('現在の設定をすべて上書きしてインポートします。よろしいですか？')) return; setStatus('設定をインポート中...'); try { const zip = await JSZip.loadAsync(file); const settingsFile = zip.file("settings.json"); if (!settingsFile) throw new Error("ZIP内にsettings.jsonが見つかりません。"); const settingsJson = await settingsFile.async("string"); const importedState = JSON.parse(settingsJson); for (const modelId in importedState) { if (modelId === 'uiSettings' || !importedState[modelId].images) continue; for (const image of importedState[modelId].images) { if (typeof image.dataUrl === 'string' && image.dataUrl.startsWith('images/')) { const imageFile = zip.file(image.dataUrl); if (imageFile) { const base64Data = await imageFile.async("base64"); const mimeType = `image/${image.dataUrl.split('.').pop()}`; image.dataUrl = `data:${mimeType};base64,${base64Data}`; } } } } appState = importedState; saveState(); alert('インポートが完了しました。ページをリロードします。'); location.reload(); } catch (error) { console.error("インポートエラー:", error); setStatus(`インポートに失敗しました: ${error.message}`, true); } };
function renderLoop() { bodyElement.style.backgroundSize = `${100 * tempBgSettings.scale}%`; bodyElement.style.backgroundPosition = `${tempBgSettings.pixelX}px ${tempBgSettings.pixelY}px`; if (isAdjustMode) { animationFrameId = requestAnimationFrame(renderLoop); } }
function onBgMouseDown(e) { isDraggingBg = true; dragStart = { mouseX: e.clientX, mouseY: e.clientY, pixelX: tempBgSettings.pixelX, pixelY: tempBgSettings.pixelY }; bodyElement.classList.add('grabbing'); }
function onBgMouseUp() { isDraggingBg = false; bodyElement.classList.remove('grabbing'); }
function onBgMouseMove(e) { if (!isDraggingBg) return; const dx = e.clientX - dragStart.mouseX; const dy = e.clientY - dragStart.mouseY; tempBgSettings.pixelX = dragStart.pixelX + dx; tempBgSettings.pixelY = dragStart.pixelY + dy; }
function onBgWheel(e) { e.preventDefault(); const oldScale = tempBgSettings.scale; const scaleAmount = -e.deltaY * 0.001 * oldScale; const newScale = Math.max(0.1, Math.min(oldScale + scaleAmount, 10)); tempBgSettings.scale = newScale; const cursorX = e.clientX; const cursorY = e.clientY; tempBgSettings.pixelX = cursorX - (cursorX - tempBgSettings.pixelX) * (newScale / oldScale); tempBgSettings.pixelY = cursorY - (cursorY - tempBgSettings.pixelY) * (newScale / oldScale); }
function getDistance(t1, t2) { return Math.sqrt(Math.pow(t1.clientX - t2.clientX, 2) + Math.pow(t1.clientY - t2.clientY, 2)); }
function onBgTouchStart(e) { if (e.touches.length === 1) { isPanning = true; panStart = { touchX: e.touches[0].clientX, touchY: e.touches[0].clientY, pixelX: tempBgSettings.pixelX, pixelY: tempBgSettings.pixelY }; } if (e.touches.length === 2) { isPinching = true; isPanning = false; lastPinchDist = getDistance(e.touches[0], e.touches[1]); } }
function onBgTouchMove(e) { e.preventDefault(); if (isPanning && e.touches.length === 1) { const dx = e.touches[0].clientX - panStart.touchX; const dy = e.touches[0].clientY - panStart.touchY; tempBgSettings.pixelX = panStart.pixelX + dx; tempBgSettings.pixelY = panStart.pixelY + dy; } if (isPinching && e.touches.length === 2) { const oldScale = tempBgSettings.scale; const newDist = getDistance(e.touches[0], e.touches[1]); const newScale = Math.max(0.1, Math.min(oldScale * (newDist / lastPinchDist), 10)); tempBgSettings.scale = newScale; const cursorX = (e.touches[0].clientX + e.touches[1].clientX) / 2; const cursorY = (e.touches[0].clientY + e.touches[1].clientY) / 2; tempBgSettings.pixelX = cursorX - (cursorX - tempBgSettings.pixelX) * (newScale / oldScale); tempBgSettings.pixelY = cursorY - (cursorY - tempBgSettings.pixelY) * (newScale / oldScale); lastPinchDist = newDist; } }
function onBgTouchEnd(e) { if (e.touches.length < 2) isPinching = false; if (e.touches.length < 1) isPanning = false; }
const bgEventListeners = { mousedown: onBgMouseDown, mouseup: onBgMouseUp, mousemove: onBgMouseMove, wheel: onBgWheel, touchstart: onBgTouchStart, touchend: onBgTouchEnd, touchmove: onBgTouchMove };
function startBgAdjustMode() { const activeImage = getActiveImage(getCurrentModelId()); if (!activeImage) { bgAdjustToggle.checked = false; return; } isAdjustMode = true; tempBgSettings.pixelX = activeImage.pixelX || 0; tempBgSettings.pixelY = activeImage.pixelY || 0; tempBgSettings.scale = activeImage.scale || 1.0; bodyElement.classList.add('bg-adjust-mode', 'no-transition'); setTimeout(() => bodyElement.classList.remove('no-transition'), 50); adjustModeControls.style.display = 'flex'; for (const [event, handler] of Object.entries(bgEventListeners)) { window.addEventListener(event, handler, { passive: false }); } animationFrameId = requestAnimationFrame(renderLoop); }
function endBgAdjustMode({ revert = false } = {}) { cancelAnimationFrame(animationFrameId); isAdjustMode = false; bgAdjustToggle.checked = false; bodyElement.classList.remove('bg-adjust-mode'); adjustModeControls.style.display = 'none'; for (const [event, handler] of Object.entries(bgEventListeners)) { window.removeEventListener(event, handler); } if (revert) { applyBackground(getActiveImage(getCurrentModelId())); } }
function performFadeSwitch(updateAction) { const oldStyle = window.getComputedStyle(bodyElement); bgFadeOverlay.style.transition = 'none'; bgFadeOverlay.style.backgroundImage = oldStyle.backgroundImage; bgFadeOverlay.style.backgroundSize = oldStyle.backgroundSize; bgFadeOverlay.style.backgroundPosition = oldStyle.backgroundPosition; bgFadeOverlay.style.opacity = '1'; bgFadeOverlay.style.zIndex = -1; requestAnimationFrame(() => { bodyElement.classList.add('no-transition'); updateAction(); requestAnimationFrame(() => { bodyElement.classList.remove('no-transition'); bgFadeOverlay.style.zIndex = 1; bgFadeOverlay.style.transition = 'opacity 0.5s ease-in-out'; bgFadeOverlay.style.opacity = '0'; }); }); }

function audioBufferToWav(buffer) {
    const numOfChan = buffer.numberOfChannels;
    const length = buffer.length * numOfChan * 2 + 44; // 16bit PCM
    const arrayBuffer = new ArrayBuffer(length);
    const view = new DataView(arrayBuffer);
    const channels = [];
    let i, sample;
    let offset = 0;
    let pos = 0;

    const setUint16 = (data) => { view.setUint16(pos, data, true); pos += 2; }
    const setUint32 = (data) => { view.setUint32(pos, data, true); pos += 4; }

    setUint32(0x46464952); // "RIFF"
    setUint32(length - 8);
    setUint32(0x45564157); // "WAVE"
    setUint32(0x20746d66); // "fmt "
    setUint32(16);
    setUint16(1); // PCM
    setUint16(numOfChan);
    setUint32(buffer.sampleRate);
    setUint32(buffer.sampleRate * 2 * numOfChan); // byte rate
    setUint16(numOfChan * 2); // block align
    setUint16(16); // bits per sample
    setUint32(0x61746164); // "data"
    setUint32(length - pos);

    for (i = 0; i < numOfChan; i++) {
        channels.push(buffer.getChannelData(i));
    }

    offset = pos;
    for (i = 0; i < buffer.length; i++) {
        for (let chan = 0; chan < numOfChan; chan++) {
            sample = Math.max(-1, Math.min(1, channels[chan][i]));
            sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0;
            view.setInt16(offset, sample, true);
            offset += 2;
        }
    }
    return new Blob([view], { type: "audio/wav" });
}

// --- イベントリスナー ---
const setupEventListeners = () => {
    tabButtons.forEach(button => button.addEventListener('click', () => { 
        bodyElement.classList.add('no-transition'); 
        tabButtons.forEach(btn => btn.classList.remove('active')); 
        tabContents.forEach(content => content.classList.remove('active')); 
        button.classList.add('active'); 
        const activeTab = document.getElementById(`tab-${button.dataset.tab}`);
        activeTab.classList.add('active'); 
        
        // R2タブがクリックされたら、HTML側で定義されたloadR2Gallery関数を呼び出す
        if (button.dataset.tab === 'r2-gallery' && typeof loadR2Gallery === 'function') {
            loadR2Gallery();
        }

        if (isAdjustMode) { endBgAdjustMode({ revert: true }); } 
        setTimeout(() => bodyElement.classList.remove('no-transition'), 50); 
    }));
    const uiSettingsMap = [ { slider: uiWidthSlider, input: uiWidthInput, key: 'width' }, { slider: uiOpacitySlider, input: uiOpacityInput, key: 'opacity' } ];
    uiSettingsMap.forEach(({ slider, input, key }) => { const handler = e => { appState.uiSettings[key] = e.target.value; applyUiSettings(); }; slider.addEventListener('input', e => { input.value = e.target.value; handler(e); }); input.addEventListener('input', e => { slider.value = e.target.value; handler(e); }); slider.addEventListener('change', saveState); input.addEventListener('change', saveState); });
    resetUiBtn.addEventListener('click', () => { if (confirm('現在のUI設定（横幅、透過度、位置）をすべてデフォルトに戻します。よろしいですか？')) { const defaultWidth = 700; appState.uiSettings = { ...defaultUiSettings, width: defaultWidth, posX: (window.innerWidth - defaultWidth) / 2 }; saveState(); applyUiSettings(); setStatus('UI設定をリセットしました。'); } });
    let isDragging = false, initialMouseX, initialMouseY, initialUiPosX, initialUiPosY;
    containerHeader.addEventListener('mousedown', e => { if (e.target.closest('.tab-button')) return; isDragging = true; bodyElement.classList.add('ui-dragging'); containerWrapper.style.transition = 'none'; initialMouseX = e.clientX; initialMouseY = e.clientY; initialUiPosX = containerWrapper.offsetLeft; initialUiPosY = containerWrapper.offsetTop; e.preventDefault(); });
    window.addEventListener('mousemove', e => { if (!isDragging) return; let newPosX = initialUiPosX + (e.clientX - initialMouseX); let newPosY = initialUiPosY + (e.clientY - initialMouseY); newPosX = Math.max(0, Math.min(window.innerWidth - containerWrapper.offsetWidth, newPosX)); newPosY = Math.max(0, Math.min(window.innerHeight - containerWrapper.offsetHeight, newPosY)); containerWrapper.style.left = `${newPosX}px`; containerWrapper.style.top = `${newPosY}px`; });
    window.addEventListener('mouseup', () => { if (!isDragging) return; isDragging = false; bodyElement.classList.remove('ui-dragging'); containerWrapper.style.transition = 'max-width 0.3s, opacity 0.3s, visibility 0.3s, left 0.3s, top 0.3s'; appState.uiSettings.posX = containerWrapper.offsetLeft; appState.uiSettings.posY = containerWrapper.offsetTop; saveState(); });
    resetAllBgsBtn.addEventListener('click', () => { const confirmationText = "背景リセット"; const userInput = prompt(`この操作は元に戻せません。\n全てのモデルの表示名と背景画像が削除されます。\n\nリセットを実行するには「${confirmationText}」と入力してください。`); if (userInput === confirmationText) { Object.keys(appState).forEach(key => { if (key !== 'uiSettings') { delete appState[key]; } }); saveState(); alert('すべての背景設定がリセットされました。ページをリロードします。'); location.reload(); } else if (userInput !== null) { alert('入力が一致しませんでした。リセットはキャンセルされました。'); } });
    [modelSelectTTS, modelSelectBG].forEach(sel => sel.addEventListener('change', (e) => { const newModelId = e.target.value; modelSelectTTS.value = newModelId; modelSelectBG.value = newModelId; performFadeSwitch(() => renderUIForSelectedModel()); }));
    saveDisplayNameBtn.addEventListener('click', () => { const modelId = getCurrentModelId(); if (modelId) { getModelData(modelId).displayName = displayNameInput.value.trim(); saveState(); updateSelectOptions(); } });
    bodyElement.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); if (!isAdjustMode) bodyElement.classList.add('drag-over'); });
    bodyElement.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); bodyElement.classList.remove('drag-over'); });
    bodyElement.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); bodyElement.classList.remove('drag-over'); if (e.dataTransfer.files.length > 0) { handleFile(e.dataTransfer.files[0]); } });
    uploadImageBtn.addEventListener('click', () => imageUploadInput.click());
    imageUploadInput.addEventListener('change', (e) => { if (e.target.files.length > 0) { handleFile(e.target.files[0]); } e.target.value = null; });
    galleryContainer.addEventListener('click', (e) => { const item = e.target.closest('.gallery-item'); if (!item) return; const modelId = getCurrentModelId(), imageId = Number(item.dataset.imageId), modelData = getModelData(modelId); if (e.target.classList.contains('btn-delete-img')) { if (confirm(`画像「${modelData.images.find(img => img.id === imageId).name}」を削除しますか？`)) { if (modelData.activeImageId === imageId) { modelData.activeImageId = null; performFadeSwitch(() => applyBackground(null)); if (isAdjustMode) endBgAdjustMode(); document.getElementById('image-adjust-panel').style.display = 'none'; } modelData.images = modelData.images.filter(img => img.id !== imageId); saveState(); renderGallery(modelId); } } else if (e.target.tagName === 'IMG') { modelData.activeImageId = imageId; saveState(); performFadeSwitch(() => renderUIForSelectedModel()); } });
    bgAdjustToggle.addEventListener('change', () => { bgAdjustToggle.checked ? startBgAdjustMode() : endBgAdjustMode({ revert: true }); });
    revertBgChangesBtn.addEventListener('click', () => endBgAdjustMode({ revert: true }));
    applyBgChangesBtn.addEventListener('click', () => { const activeImage = getActiveImage(getCurrentModelId()); if (activeImage) { activeImage.pixelX = tempBgSettings.pixelX; activeImage.pixelY = tempBgSettings.pixelY; activeImage.scale = tempBgSettings.scale; activeImage.name = createImageName(activeImage); saveState(); renderGallery(getCurrentModelId()); applyBackground(activeImage); setStatus('背景設定を適用しました。'); } endBgAdjustMode(); });
    styleStrengthInput.addEventListener('input', () => { strengthValueSpan.textContent = parseFloat(styleStrengthInput.value).toFixed(2); });
    
    resultsContainer.addEventListener('click', async (e) => {
        const button = e.target.closest('.icon-btn'); if (!button) return;
        const card = button.closest('.player-card'); const cardId = card.dataset.cardId;
        if (button.classList.contains('btn-regenerate')) {
            await handleRegenerate(card);
        } else if (button.classList.contains('btn-undo')) {
            const state = resultStates[cardId];
            if (state && state.currentIndex > 0) { state.currentIndex--; updateCardUI(cardId); }
        } else if (button.classList.contains('btn-redo')) {
            const state = resultStates[cardId];
            if (state && state.currentIndex < state.history.length - 1) { state.currentIndex++; updateCardUI(cardId); }
        } else if (button.classList.contains('btn-add')) {
            await addResultCard({ status: 'empty', text: '' }, card);
        } else if (button.classList.contains('btn-delete')) {
            const state = resultStates[cardId];
            if (confirm('このブロックを削除しますか？')) {
                if (state && state.audioUrl) URL.revokeObjectURL(state.audioUrl);
                delete resultStates[cardId];
                card.remove();
                updateAllCardUIs();
            }
        }
    });

    resultsContainer.addEventListener('keydown', async (e) => {
        if (e.target.classList.contains('editable-text') && e.key === 'Enter') {
            e.preventDefault();
            const card = e.target.closest('.player-card');
            if (card) {
                e.target.blur();
                await handleRegenerate(card);
            }
        }
    });

    async function handleRegenerate(card) {
        const cardId = card.dataset.cardId;
        const state = resultStates[cardId];
        const regenBtn = card.querySelector('.btn-regenerate');
        const cardStatus = card.querySelector('.card-status');
        const editableText = card.querySelector('.editable-text');
        const currentText = editableText.textContent.trim();
        if (!currentText) { cardStatus.textContent = 'テキストが空です。'; return; }
        if (regenBtn) regenBtn.disabled = true;
        cardStatus.textContent = '再生成中...';
        const results = await processAudioRequest([currentText]);
        if (regenBtn) regenBtn.disabled = false;
        cardStatus.textContent = '';
        if (results && results[0] && results[0].status === 'success') {
            try {
                const newBlob = await processServerResponseAudio(results[0].audio_base_64, results[0].content_type);
                addHistoryEntry(cardId, { blob: newBlob, text: currentText });
                state.error = null;
                updateCardUI(cardId);
            } catch (error) {
                state.error = error.message;
                updateCardUI(cardId);
            }
        } else {
            const reason = (results && results[0] && results[0].reason) || '不明なエラー';
            state.error = reason;
            updateCardUI(cardId);
        }
        updateAllCardUIs();
    }

    generateBtn.addEventListener('click', async () => {
        Object.values(resultStates).forEach(state => { if (state.audioUrl) URL.revokeObjectURL(state.audioUrl); });
        resultsContainer.innerHTML = ''; resultStates = {};
        combinedPreviewArea.style.display = 'none'; updateAllCardUIs(); 
        
        combinedResultContainer.style.display = 'none';
        saveToR2Btn.style.display = 'none';
        currentCombinedAudioBlob = null;
        currentCombinedAudioFilename = '';

        let lines = textInput.value.split('\n').filter(line => line.trim() !== '');
        if (lines.length === 0) { setStatus('テキストを入力してください。', true); return; }
        const results = await processAudioRequest(lines);
        if (!results) {
            for (const line of lines) {
                await addResultCard({ text: line, status: 'error', reason: statusDiv.textContent || 'サーバーとの通信に失敗しました。' });
            }
            setStatus(`音声生成リクエストに失敗しました。「合成結果」タブで詳細を確認してください。`, true);
            return;
        }
        let successCount = 0; const successfulBlobs = [];
        for (const result of results) {
            await addResultCard(result);
            if (result.status === 'success') {
                 try {
                    const decodedBlob = await processServerResponseAudio(result.audio_base_64, result.content_type);
                    successfulBlobs.push(decodedBlob);
                    successCount++;
                } catch (e) {
                    console.error("Audio decoding failed for preview:", e);
                }
            }
        }
        if (successCount > 0) { setStatus(`${successCount} / ${results.length} 件の音声を生成しました。「合成結果」タブで個別に確認・ダウンロードできます。`); } else { setStatus(`音声の生成に失敗しました。「合成結果」タブでエラー内容を確認してください。`, true); }
        
        if (successfulBlobs.length > 0) {
            if (combinedAudioPlayer.src) URL.revokeObjectURL(combinedAudioPlayer.src);
            const combinedBlob = await combineAudioBlobs(successfulBlobs, []);
            if(combinedBlob) {
                currentCombinedAudioBlob = combinedBlob;
                const url = URL.createObjectURL(combinedBlob);
                combinedAudioPlayer.src = url;
                
                const formatConfig = getFormatConfigByContentType(combinedBlob.type);
                const successfulLines = results.filter(r => r.status === 'success').map(r => r.text);
                const combinedName = successfulLines.join('_');
                currentCombinedAudioFilename = createSafeFileName(getCurrentModelId(), combinedName, formatConfig.extension);

                downloadCombinedBtn.onclick = () => {
                    const a = document.createElement('a'); a.href = url;
                    a.download = currentCombinedAudioFilename;
                    document.body.appendChild(a); a.click(); document.body.removeChild(a);
                };
                downloadCombinedBtn.style.backgroundColor = 'var(--primary-color)';
                combinedResultContainer.style.display = 'block';
                downloadCombinedBtn.style.display = 'block';
                saveToR2Btn.style.display = 'block';
                downloadCombinedBtn.textContent = successfulBlobs.length > 1 ? '結合音声をダウンロード' : 'この音声をダウンロード';
            }
        }
    });
    
    generatePreviewBtn.addEventListener('click', async () => {
         const validAudios = []; const intervals = []; const allCards = resultsContainer.querySelectorAll('.player-card');
         
         for (let i = 0; i < allCards.length; i++) {
             const card = allCards[i]; const cardId = card.dataset.cardId; const state = resultStates[cardId];
             if (state && state.history.length > 0 && state.currentIndex >= 0) {
                 const currentHistoryEntry = state.history[state.currentIndex];
                 validAudios.push({ blob: currentHistoryEntry.blob, text: currentHistoryEntry.text });
                 if (i < allCards.length - 1) { const intervalInput = card.querySelector('.interval-input'); intervals.push(parseFloat(intervalInput.value) || 0); }
             }
         }
         if (validAudios.length === 0) { setStatus('結合する有効な音声がありません。', true); return; }
         
         const allIntervalsAreZero = intervals.every(interval => interval === 0);
         
         let finalFormat = formatSelect.value;
         let statusMessage = '音声ファイルを結合中...';
         if (!allIntervalsAreZero) {
             finalFormat = 'wav';
             statusMessage = '無音区間を挟むため、音声をデコードしてWAV形式で結合します...';
         }
         setStatus(statusMessage);
         generatePreviewBtn.disabled = true;
         
         let combinedBlob;
         
         if (allIntervalsAreZero) {
             const blobs = validAudios.map(a => a.blob);
             combinedBlob = await combineAudioBlobs(blobs, []);
         } else {
             try {
                 const decodedBuffers = await Promise.all(
                     validAudios.map(audio => audio.blob.arrayBuffer().then(buffer => audioContextForDecoding.decodeAudioData(buffer)))
                 );
                 
                 const sampleRate = decodedBuffers[0].sampleRate;
                 const numberOfChannels = Math.max(...decodedBuffers.map(b => b.numberOfChannels));
                 
                 let totalLength = 0;
                 decodedBuffers.forEach((buffer, index) => {
                     totalLength += buffer.length;
                     if (index < intervals.length) {
                         totalLength += Math.round(intervals[index] * sampleRate);
                     }
                 });
                 
                 const mergedBuffer = audioContextForDecoding.createBuffer(numberOfChannels, totalLength, sampleRate);
                 let currentOffset = 0;
                 
                 for(let i = 0; i < decodedBuffers.length; i++) {
                     const buffer = decodedBuffers[i];
                     for (let channel = 0; channel < numberOfChannels; channel++) {
                         if (channel < buffer.numberOfChannels) {
                             mergedBuffer.copyToChannel(buffer.getChannelData(channel), channel, currentOffset);
                         }
                     }
                     currentOffset += buffer.length;
                     
                     if (i < intervals.length && intervals[i] > 0) {
                         currentOffset += Math.round(intervals[i] * sampleRate);
                     }
                 }
                 combinedBlob = audioBufferToWav(mergedBuffer);
             } catch (error) {
                 console.error("WAVへのデコード・結合中にエラー:", error);
                 setStatus(`WAVへのデコード・結合に失敗しました: ${error.message}`, true);
                 generatePreviewBtn.disabled = false;
                 return;
             }
         }
         
         if (!combinedBlob) {
             setStatus('音声の結合に失敗しました。', true);
             generatePreviewBtn.disabled = false;
             return;
         }
         
         setStatus('結合プレビューが生成されました。');
         generatePreviewBtn.disabled = false;
         if (combinedPreviewPlayer.src) URL.revokeObjectURL(combinedPreviewPlayer.src);
         
         currentPreviewAudioBlob = combinedBlob;
         const formatConfig = FORMAT_MAPPING[finalFormat];
         const combinedTextForFilename = validAudios.map(a => a.text).join('_');
         const representativeModelId = getCurrentModelId();
         currentPreviewAudioFilename = createSafeFileName(representativeModelId, combinedTextForFilename, formatConfig.extension);

         const url = URL.createObjectURL(combinedBlob);
         combinedPreviewPlayer.src = url;
         combinedPreviewArea.style.display = 'block';
         
         downloadCombinedPreviewBtn.textContent = `この結合音声 (${finalFormat.toUpperCase()}) をダウンロード`;
         
         downloadCombinedPreviewBtn.onclick = () => {
             const a = document.createElement('a');
             a.href = url;
             a.download = currentPreviewAudioFilename;
             document.body.appendChild(a);
             a.click();
             document.body.removeChild(a);
         };
    });

    addFirstCardBtn.addEventListener('click', () => addResultCard({ status: 'empty', text: '' }));
    exportAllSettingsBtn.addEventListener('click', exportAllSettings);
};

const updateFormatSelectVisibility = () => {
    const opusOption = document.querySelector('#format-select option[value="opus"]');
    const flacOption = document.querySelector('#format-select option[value="flac"]');
    if(flacOption) flacOption.style.display = 'none';
    if(opusOption) opusOption.style.display = SHOW_ADVANCED_FORMATS ? '' : 'none';
    if (formatSelect.value === 'flac') {
        formatSelect.value = 'mp3';
    }
}
const init = async () => {
    loadState(); applyUiSettings(); updateFormatSelectVisibility();
    try {
        const response = await fetch('/get-models');
        if (!response.ok) throw new Error('モデル取得に失敗しました。');
        originalModels = await response.json();
        [modelSelectTTS, modelSelectBG].forEach(sel => { sel.innerHTML = ''; originalModels.forEach(model => { const option = document.createElement('option'); option.value = model.id; option.textContent = model.name; sel.appendChild(option); }); });
        if (originalModels.length > 0) { updateSelectOptions(); renderUIForSelectedModel(); } 
        else { setStatus('利用可能なモデルがありません。', true); }
    } catch (error) { 
        console.warn(`モデル取得に失敗しました: ${error.message}。ダミーデータで初期化します。`);
        setStatus('モデル取得に失敗。ダミーデータを使用します。');
        originalModels = [
             { id: 'dummy_model_1', name: 'ダミーモデルA' },
             { id: 'dummy_model_2', name: 'ダミーモデルB' },
        ];
        [modelSelectTTS, modelSelectBG].forEach(sel => { sel.innerHTML = ''; originalModels.forEach(model => { const option = document.createElement('option'); option.value = model.id; option.textContent = model.name; sel.appendChild(option); }); });
        updateSelectOptions(); 
        renderUIForSelectedModel();
    }
    setupEventListeners();
    updateAllCardUIs();
};
window.addEventListener('load', init);