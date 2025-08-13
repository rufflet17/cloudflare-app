// =========================================================================
// --- 3. 音声生成と音声加工 ---
// =========================================================================

// --- 音声加工・生成関数 ---

function createSilence(durationSeconds, format, sampleRate = 44100, channels = 1, bitDepth = 16) {
    if (format === 'wav') {
        const bytesPerSample = bitDepth / 8;
        const blockAlign = channels * bytesPerSample;
        const numSamples = Math.round(sampleRate * durationSeconds);
        const dataSize = numSamples * blockAlign;
        const buffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(buffer);
        view.setUint32(0, 0x52494646, false); // "RIFF"
        view.setUint32(4, 36 + dataSize, true); // file size - 8
        view.setUint32(8, 0x57415645, false); // "WAVE"
        view.setUint32(12, 0x666d7420, false); // "fmt "
        view.setUint32(16, 16, true); // PCM chunk size
        view.setUint16(20, 1, true); // PCM format
        view.setUint16(22, channels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * blockAlign, true); // byte rate
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitDepth, true);
        view.setUint32(36, 0x64617461, false); // "data"
        view.setUint32(40, dataSize, true);
        const blob = new Blob([buffer], { type: 'audio/wav' });
        blob.isSilence = true;
        return blob;
    } else if (format === 'mp3') {
        const silentFrame = new Uint8Array([0xff, 0xfb, 0x10, 0xc4, 0x00, 0x00, 0x00, 0x03, 0x48, 0x00, 0x00, 0x00, 0x00, 0x4c, 0x41, 0x4d, 0x45, 0x33, 0x2e, 0x31, 0x30, 0x30]);
        const frameDuration = 1152 / 44100; // LAME 3.100 44.1kHz CBR 32kbps
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
    let offset = 12; // "RIFF" + size + "WAVE"
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
    headerView.setUint32(4, 36 + totalDataSize, true); // file size - 8
    headerView.setUint32(8, 0x57415645, false); // "WAVE"
    headerView.setUint32(12, 0x666d7420, false); // "fmt "
    headerView.setUint32(16, 16, true); // PCM chunk size
    headerView.setUint16(20, 1, true); // PCM format
    headerView.setUint16(22, channels, true);
    headerView.setUint32(24, sampleRate, true);
    headerView.setUint32(28, byteRate, true); // byte rate
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
            if (buffer.length > 10 && view.getUint32(0, false) >> 8 === 0x494433) { // ID3
                const size = (view.getUint8(6) << 21) | (view.getUint8(7) << 14) | (view.getUint8(8) << 7) | view.getUint8(9);
                offset = 10 + size;
            }
        }
        let end = buffer.length;
        if (i < blobs.length - 1) { // Not the last blob
            const view = new DataView(buffer.buffer);
            if (buffer.length > 128 && view.getUint32(buffer.length - 128, false) >> 8 === 0x544147) { // TAG
                end -= 128;
            }
        }
        processedBuffers.push(buffer.slice(offset, end));
    }
    return new Blob(processedBuffers, { type: 'audio/mpeg' });
};

const getFormatConfigByContentType = (contentType) => {
    if (!contentType) return { extension: 'bin', contentType: 'application/octet-stream' };
    return Object.values(FORMAT_MAPPING).find(config => config.contentType === contentType.split(';')[0].trim()) || { extension: 'bin', contentType };
};

const base64ToBlob = (base64, contentType) => {
    const byteCharacters = atob(base64);
    const byteArrays = [];
    for (let offset = 0; offset < byteCharacters.length; offset += 512) {
        const slice = byteCharacters.slice(offset, offset + 512);
        const byteNumbers = new Array(slice.length);
        for (let i = 0; i < slice.length; i++) byteNumbers[i] = slice.charCodeAt(i);
        byteArrays.push(new Uint8Array(byteNumbers));
    }
    return new Blob(byteArrays, { type: contentType });
};

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

function audioBufferToWav(buffer) {
    const numOfChan = buffer.numberOfChannels;
    const length = buffer.length * numOfChan * 2 + 44;
    const arrayBuffer = new ArrayBuffer(length);
    const view = new DataView(arrayBuffer);
    const channels = [];
    let i, sample;
    let offset = 0;
    let pos = 0;

    const setUint16 = (data) => { view.setUint16(pos, data, true); pos += 2; };
    const setUint32 = (data) => { view.setUint32(pos, data, true); pos += 4; };

    setUint32(0x46464952); // "RIFF"
    setUint32(length - 8);
    setUint32(0x45564157); // "WAVE"
    setUint32(0x20746d66); // "fmt "
    setUint32(16);
    setUint16(1);
    setUint16(numOfChan);
    setUint32(buffer.sampleRate);
    setUint32(buffer.sampleRate * 2 * numOfChan);
    setUint16(numOfChan * 2);
    setUint16(16);
    setUint32(0x61746164); // "data"
    setUint32(length - pos - 4);

    for (i = 0; i < numOfChan; i++) {
        channels.push(buffer.getChannelData(i));
    }

    while (pos < length) {
        for (i = 0; i < buffer.length; i++) {
            for (let chan = 0; chan < numOfChan; chan++) {
                sample = Math.max(-1, Math.min(1, channels[chan][i]));
                sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0;
                view.setInt16(pos, sample, true);
                pos += 2;
            }
        }
    }
    return new Blob([view], { type: "audio/wav" });
}

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
    if (errors.length > 0) { setStatus(errors.join(' / '), true); return false; }
    return true;
};

const processAudioRequest = async (linesToProcess) => {
    if (!validateInput(linesToProcess)) return null;
    generateBtn.disabled = true;
    generatePreviewBtn.disabled = true;
    setStatus(`${linesToProcess.length}件の音声を生成中...`);
    try {
        const requestFormat = formatSelect.value === 'wav' ? 'flac' : formatSelect.value;
        const response = await fetch('/synthesize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model_id: getCurrentModelId(),
                texts: linesToProcess,
                style_id: styleIdInput.value,
                style_strength: parseFloat(styleStrengthInput.value),
                format: requestFormat
            })
        });
        if (!response.ok) throw new Error(`APIエラー (${response.status}): ${await response.text()}`);
        return await response.json();
    } catch (error) {
        setStatus(error.message, true);
        return null;
    } finally {
        generateBtn.disabled = false;
        updateAllCardUIs();
    }
};

const addHistoryEntry = (cardId, newEntry) => {
    const state = resultStates[cardId];
    if (!state) return;
    state.history.splice(state.currentIndex + 1);
    state.history.push(newEntry);
    state.currentIndex = state.history.length - 1;
};

const updateCardUI = (cardId) => {
    const state = resultStates[cardId];
    if (!state) return;
    const card = document.querySelector(`[data-card-id="${cardId}"]`);
    if (!card) return;

    const audio = card.querySelector('audio');
    const downloadLink = card.querySelector('.download-link');
    const undoBtn = card.querySelector('.btn-undo');
    const redoBtn = card.querySelector('.btn-redo');
    const errorMessageDiv = card.querySelector('.error-message');
    const editableText = card.querySelector('.editable-text');

    const hasAudio = state.history.length > 0 && state.currentIndex >= 0;
    const isTrueError = !!state.error;

    card.classList.toggle('is-error', isTrueError);
    audio.style.display = hasAudio ? 'block' : 'none';
    downloadLink.style.display = hasAudio ? 'flex' : 'none';
    undoBtn.style.display = hasAudio ? 'flex' : 'none';
    redoBtn.style.display = hasAudio ? 'flex' : 'none';
    errorMessageDiv.style.display = !hasAudio ? 'block' : 'none';

    if (!hasAudio) {
        if (isTrueError) {
            errorMessageDiv.textContent = `エラー: ${state.error}`;
            errorMessageDiv.style.color = '';
        } else {
            errorMessageDiv.textContent = 'テキストを入力し、再生成ボタン(↻)を押してください。';
            errorMessageDiv.style.color = '#6c757d';
        }
        editableText.textContent = state.initialText;
    } else {
        const currentHistoryEntry = state.history[state.currentIndex];
        editableText.textContent = currentHistoryEntry.text;
        if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
        const url = URL.createObjectURL(currentHistoryEntry.blob);
        state.audioUrl = url;
        audio.src = url;
        downloadLink.href = url;
        const formatConfig = getFormatConfigByContentType(currentHistoryEntry.blob.type);
        downloadLink.download = createSafeFileName(getCurrentModelId(), currentHistoryEntry.text, formatConfig.extension);
    }
    undoBtn.disabled = !hasAudio || state.currentIndex <= 0;
    redoBtn.disabled = !hasAudio || state.currentIndex >= state.history.length - 1;
};

const addResultCard = async (result, insertAfterCard = null) => {
    const cardId = `card-${Date.now()}-${Math.random()}`;
    const card = document.createElement('div');
    card.className = 'player-card';
    card.dataset.cardId = cardId;
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
        </div>
    `;

    if (result.status === 'success') {
        try {
            const audioBlob = await processServerResponseAudio(result.audio_base_64, result.content_type);
            resultStates[cardId] = { initialText: result.text, history: [{ blob: audioBlob, text: result.text }], currentIndex: 0, error: null, audioUrl: null };
        } catch (error) {
            resultStates[cardId] = { initialText: result.text, history: [], currentIndex: -1, error: error.message, audioUrl: null };
        }
    } else {
        resultStates[cardId] = { initialText: result.text, history: [], currentIndex: -1, error: result.reason || null, audioUrl: null };
    }

    if (insertAfterCard) {
        insertAfterCard.after(card);
    } else {
        resultsContainer.appendChild(card);
    }
    updateCardUI(cardId);
    updateAllCardUIs();
    return card;
};

const updateAllCardUIs = () => {
    const cards = resultsContainer.querySelectorAll('.player-card');
    cards.forEach((card, index) => {
        const indexSpan = card.querySelector('.card-index');
        if(indexSpan) indexSpan.textContent = `[${index + 1}]`;
        const intervalControl = card.querySelector('.interval-control');
        if(intervalControl) intervalControl.style.display = (index < cards.length - 1) ? 'flex' : 'none';
    });
    const validAudioCount = Array.from(cards).filter(card => {
        const state = resultStates[card.dataset.cardId];
        return state && state.history.length > 0 && state.currentIndex >= 0;
    }).length;

    resultsPlaceholder.style.display = cards.length > 0 ? 'none' : 'block';
    generatePreviewBtn.disabled = validAudioCount < 1;
};

// --- イベントリスナー設定 & 初期化 ---

async function handleRegenerate(card) {
    const cardId = card.dataset.cardId;
    const state = resultStates[cardId];
    const regenBtn = card.querySelector('.btn-regenerate');
    const cardStatus = card.querySelector('.card-status');
    const editableText = card.querySelector('.editable-text');
    const currentText = editableText.textContent.trim();

    if (!currentText) {
        cardStatus.textContent = 'テキストが空です。';
        return;
    }
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


function setupAudioEventListeners() {
    styleStrengthInput.addEventListener('input', () => {
        strengthValueSpan.textContent = parseFloat(styleStrengthInput.value).toFixed(2);
    });

    resultsContainer.addEventListener('click', async (e) => {
        const button = e.target.closest('.icon-btn');
        if (!button) return;
        const card = button.closest('.player-card');
        const cardId = card.dataset.cardId;
        if (button.classList.contains('btn-regenerate')) {
            await handleRegenerate(card);
        } else if (button.classList.contains('btn-undo')) {
            const state = resultStates[cardId];
            if (state && state.currentIndex > 0) {
                state.currentIndex--;
                updateCardUI(cardId);
            }
        } else if (button.classList.contains('btn-redo')) {
            const state = resultStates[cardId];
            if (state && state.currentIndex < state.history.length - 1) {
                state.currentIndex++;
                updateCardUI(cardId);
            }
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

    generateBtn.addEventListener('click', async () => {
        Object.values(resultStates).forEach(state => { if (state.audioUrl) URL.revokeObjectURL(state.audioUrl); });
        resultsContainer.innerHTML = '';
        resultStates = {};
        combinedPreviewArea.style.display = 'none';
        updateAllCardUIs();
        combinedResultContainer.style.display = 'none';
        saveToR2Btn.style.display = 'none';
        currentCombinedAudioBlob = null;
        currentCombinedAudioInfo = { text: '', filename: '' };

        let lines = textInput.value.split('\n').filter(line => line.trim() !== '');
        if (lines.length === 0) {
            setStatus('テキストを入力してください。', true);
            return;
        }

        const results = await processAudioRequest(lines);
        if (!results) {
            for (const line of lines) { await addResultCard({ text: line, status: 'error', reason: statusDiv.textContent || 'サーバーとの通信に失敗しました。' }); }
            setStatus(`音声生成リクエストに失敗しました。「合成結果」タブで詳細を確認してください。`, true);
            return;
        }

        let successCount = 0;
        const successfulBlobs = [];
        for (const result of results) {
            await addResultCard(result);
            if (result.status === 'success') {
                try {
                    const decodedBlob = await processServerResponseAudio(result.audio_base_64, result.content_type);
                    successfulBlobs.push(decodedBlob);
                    successCount++;
                } catch (e) { console.error("Audio decoding failed for preview:", e); }
            }
        }
        
        if (successCount > 0) { setStatus(`${successCount} / ${results.length} 件の音声を生成しました。「合成結果」タブで個別に確認・ダウンロードできます。`); }
        else { setStatus(`音声の生成に失敗しました。「合成結果」タブでエラー内容を確認してください。`, true); }

        if (successfulBlobs.length > 0) {
            if (combinedAudioPlayer.src) URL.revokeObjectURL(combinedAudioPlayer.src);
            const combinedBlob = await combineAudioBlobs(successfulBlobs, []);
            if(combinedBlob) {
                currentCombinedAudioBlob = combinedBlob;
                const url = URL.createObjectURL(combinedBlob);
                combinedAudioPlayer.src = url;
                const formatConfig = getFormatConfigByContentType(combinedBlob.type);
                const successfulLines = results.filter(r => r.status === 'success').map(r => r.text);
                const combinedText = successfulLines.join('_');
                currentCombinedAudioInfo.text = successfulLines.join('\n');
                currentCombinedAudioInfo.filename = createSafeFileName(getCurrentModelId(), combinedText, formatConfig.extension);

                downloadCombinedBtn.onclick = () => {
                    const a = document.createElement('a'); a.href = url; a.download = currentCombinedAudioInfo.filename; document.body.appendChild(a); a.click(); document.body.removeChild(a);
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
        const validAudios = [];
        const intervals = [];
        const allCards = resultsContainer.querySelectorAll('.player-card');

        for (let i = 0; i < allCards.length; i++) {
            const card = allCards[i];
            const cardId = card.dataset.cardId;
            const state = resultStates[cardId];
            if (state && state.history.length > 0 && state.currentIndex >= 0) {
                const currentHistoryEntry = state.history[state.currentIndex];
                validAudios.push({ blob: currentHistoryEntry.blob, text: currentHistoryEntry.text });
                if (i < allCards.length - 1) {
                    const intervalInput = card.querySelector('.interval-input');
                    intervals.push(parseFloat(intervalInput.value) || 0);
                }
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

        if (!combinedBlob) { setStatus('音声の結合に失敗しました。', true); generatePreviewBtn.disabled = false; return; }

        setStatus('結合プレビューが生成されました。');
        generatePreviewBtn.disabled = false;
        if (combinedPreviewPlayer.src) URL.revokeObjectURL(combinedPreviewPlayer.src);

        currentPreviewAudioBlob = combinedBlob;
        const formatConfig = FORMAT_MAPPING[finalFormat];
        const combinedTextForFilename = validAudios.map(a => a.text).join('_');
        currentPreviewAudioInfo.text = validAudios.map(a => a.text).join('\n');
        currentPreviewAudioInfo.filename = createSafeFileName(getCurrentModelId(), combinedTextForFilename, formatConfig.extension);
        
        const url = URL.createObjectURL(combinedBlob);
        combinedPreviewPlayer.src = url;
        combinedPreviewArea.style.display = 'block';
        downloadCombinedPreviewBtn.textContent = `この結合音声 (${finalFormat.toUpperCase()}) をダウンロード`;
        downloadCombinedPreviewBtn.onclick = () => {
            const a = document.createElement('a');
            a.href = url;
            a.download = currentPreviewAudioInfo.filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        };
    });

    addFirstCardBtn.addEventListener('click', () => addResultCard({ status: 'empty', text: '' }));
}

// アプリケーションのエントリーポイント
document.addEventListener('DOMContentLoaded', () => {
    const init = async () => {
        loadState();
        applyUiSettings();
        updateFormatSelectVisibility();

        try {
            const response = await fetch('/get-models');
            if (!response.ok) throw new Error('モデル取得に失敗しました。');
            originalModels = await response.json();
            const modelOptions = originalModels.map(model => `<option value="${model.id}">${model.name}</option>`).join('');
            [modelSelectTTS, modelSelectBG].forEach(sel => { sel.innerHTML = modelOptions; });
            if (originalModels.length > 0) {
                updateSelectOptions();
                renderUIForSelectedModel();
            } else {
                setStatus('利用可能なモデルがありません。', true);
            }
        } catch (error) {
            console.warn(`モデル取得に失敗しました: ${error.message}。ダミーデータで初期化します。`);
            setStatus('モデル取得に失敗。ダミーデータを使用します。');
            originalModels = [
                { id: 'dummy_model_1', name: 'ダミーモデルA' },
                { id: 'dummy_model_2', name: 'ダミーモデルB' },
            ];
            const modelOptions = originalModels.map(model => `<option value="${model.id}">${model.name}</option>`).join('');
            [modelSelectTTS, modelSelectBG].forEach(sel => { sel.innerHTML = modelOptions; });
            updateSelectOptions();
            renderUIForSelectedModel();
        }
        
        // 各機能のイベントリスナーをセットアップ
        setupSettingsEventListeners();
        setupStorageEventListeners();
        setupAudioEventListeners();
        
        updateAllCardUIs();
    };

    init();
});