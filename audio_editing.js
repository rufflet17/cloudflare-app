/**
 * audio_editing.js
 * 音声データの処理（結合、無音生成、フォーマット変換など）に関する関数群を提供します。
 * このスクリプトはUIの状態やDOM要素に直接依存しません。
 */
window.AudioEditing = (function() {
    'use strict';

    // --- モジュール内定数と共有インスタンス ---
    const audioContextForDecoding = new (window.AudioContext || window.webkitAudioContext)();

    const FORMAT_MAPPING = {
        mp3: { contentType: 'audio/mpeg', extension: 'mp3' },
        wav: { contentType: 'audio/wav', extension: 'wav' },
        flac: { contentType: 'audio/flac', extension: 'flac' },
        opus: { contentType: 'audio/ogg', extension: 'opus' }
    };


    // --- 内部ヘルパー関数 ---

    /**
     * Base64文字列をBlobオブジェクトに変換します。
     */
    function base64toBlob(base64, contentType = '', sliceSize = 512) {
        const byteCharacters = atob(base64);
        const byteArrays = [];
        for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
            const slice = byteCharacters.slice(offset, offset + sliceSize);
            const byteNumbers = new Array(slice.length);
            for (let i = 0; i < slice.length; i++) {
                byteNumbers[i] = slice.charCodeAt(i);
            }
            byteArrays.push(new Uint8Array(byteNumbers));
        }
        return new Blob(byteArrays, { type: contentType });
    }

    /**
     * WAVファイルのデータチャンクを探します。
     */
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


    // --- 公開するAPI関数 ---

    /**
     * 指定された長さの無音データを生成します。
     * @param {number} durationSeconds - 無音の長さ（秒）。
     * @param {string} format - 'wav' または 'mp3'。
     * @param {number} sampleRate - サンプルレート。
     * @param {number} channels - チャンネル数。
     * @param {number} bitDepth - ビット深度 (WAVのみ)。
     * @returns {Blob|null} 無音データのBlobオブジェクト。
     */
    function createSilence(durationSeconds, format, sampleRate = 44100, channels = 1, bitDepth = 16) {
        if (format === 'wav') {
            const bytesPerSample = bitDepth / 8;
            const blockAlign = channels * bytesPerSample;
            const numSamples = Math.round(sampleRate * durationSeconds);
            const dataSize = numSamples * blockAlign;
            const buffer = new ArrayBuffer(44 + dataSize);
            const view = new DataView(buffer);
            view.setUint32(0, 0x52494646, false); // "RIFF"
            view.setUint32(4, 36 + dataSize, true); // ファイルサイズ - 8
            view.setUint32(8, 0x57415645, false); // "WAVE"
            view.setUint32(12, 0x666d7420, false); // "fmt "
            view.setUint32(16, 16, true); // fmtチャンクのサイズ
            view.setUint16(20, 1, true); // フォーマットID (PCM)
            view.setUint16(22, channels, true); // チャンネル数
            view.setUint32(24, sampleRate, true); // サンプルレート
            view.setUint32(28, sampleRate * blockAlign, true); // データ速度
            view.setUint16(32, blockAlign, true); // ブロックアライン
            view.setUint16(34, bitDepth, true); // ビット深度
            view.setUint32(36, 0x64617461, false); // "data"
            view.setUint32(40, dataSize, true); // データサイズ
            const blob = new Blob([buffer], { type: 'audio/wav' });
            blob.isSilence = true;
            return blob;
        } else if (format === 'mp3') {
            const silentFrame = new Uint8Array([0xff, 0xfb, 0x10, 0xc4, 0x00, 0x00, 0x00, 0x03, 0x48, 0x00, 0x00, 0x00, 0x00, 0x4c, 0x41, 0x4d, 0x45, 0x33, 0x2e, 0x31, 0x30, 0x30]);
            const frameDuration = 1152 / 44100; // 44.1kHzのMP3フレームの長さ
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

    /**
     * 複数のMP3 Blobを結合します。
     * @param {Blob[]} blobs - 結合するMP3 Blobの配列。
     * @returns {Promise<Blob>} 結合されたMP3 Blob。
     */
    async function mergeMp3Blobs(blobs) {
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
            // 先頭以外のファイルのID3v2タグをスキップ
            if (i > 0) {
                const view = new DataView(buffer.buffer);
                if (buffer.length > 10 && view.getUint32(0, false) >> 8 === 0x494433) { // "ID3"
                    const size = (view.getUint8(6) << 21) | (view.getUint8(7) << 14) | (view.getUint8(8) << 7) | view.getUint8(9);
                    offset = 10 + size;
                }
            }
            let end = buffer.length;
            // 最後以外のファイルのID3v1タグを削除
            if (i < blobs.length - 1) {
                const view = new DataView(buffer.buffer);
                if (buffer.length > 128 && view.getUint32(buffer.length - 128, false) >> 8 === 0x544147) { // "TAG"
                    end -= 128;
                }
            }
            processedBuffers.push(buffer.slice(offset, end));
        }
        return new Blob(processedBuffers, { type: 'audio/mpeg' });
    }

    /**
     * 複数のWAV Blobを結合します。
     * @param {Blob[]} blobs - 結合するWAV Blobの配列。
     * @returns {Promise<Blob|null>} 結合されたWAV Blob。
     */
    async function mergeWavBlobs(blobs) {
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
            if (!sampleRate) { // 最初の有効なファイルからヘッダ情報を取得
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
        headerView.setUint32(4, 36 + totalDataSize, true); // fileSize
        headerView.setUint32(8, 0x57415645, false); // "WAVE"
        headerView.setUint32(12, 0x666d7420, false); // "fmt "
        headerView.setUint32(16, 16, true); // fmt chunk size
        headerView.setUint16(20, 1, true); // format (PCM)
        headerView.setUint16(22, channels, true); // channels
        headerView.setUint32(24, sampleRate, true); // sample rate
        headerView.setUint32(28, byteRate, true); // byte rate
        headerView.setUint16(32, blockAlign, true); // block align
        headerView.setUint16(34, bitDepth, true); // bits per sample
        headerView.setUint32(36, 0x64617461, false); // "data"
        headerView.setUint32(40, totalDataSize, true); // data chunk size
        const combinedBlobParts = [new Uint8Array(headerBuffer), ...audioDataParts];
        return new Blob(combinedBlobParts, { type: 'audio/wav' });
    }

    /**
     * AudioBufferをWAV形式のBlobに変換します。
     * @param {AudioBuffer} buffer - 変換元のAudioBuffer。
     * @returns {Blob} WAV形式のBlob。
     */
    function audioBufferToWav(buffer) {
        const numOfChan = buffer.numberOfChannels;
        const length = buffer.length * numOfChan * 2 + 44;
        const arrayBuffer = new ArrayBuffer(length);
        const view = new DataView(arrayBuffer);
        const channels = [];
        let i, sample;
        let pos = 0;

        const setUint16 = (data) => { view.setUint16(pos, data, true); pos += 2; };
        const setUint32 = (data) => { view.setUint32(pos, data, true); pos += 4; };

        setUint32(0x46464952); // "RIFF"
        setUint32(length - 8); // file length - 8
        setUint32(0x45564157); // "WAVE"
        setUint32(0x20746d66); // "fmt " chunk
        setUint32(16); // length of format data
        setUint16(1); // type of format (1=PCM)
        setUint16(numOfChan);
        setUint32(buffer.sampleRate);
        setUint32(buffer.sampleRate * 2 * numOfChan); // byte rate
        setUint16(numOfChan * 2); // block align
        setUint16(16); // bits per sample
        setUint32(0x61746164); // "data" chunk
        setUint32(length - pos - 4); // size of data

        for (i = 0; i < numOfChan; i++) {
            channels.push(buffer.getChannelData(i));
        }

        let offset = 0;
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

    /**
     * サーバーからのBase64音声データを処理し、必要に応じてフォーマットを変換します。
     * @param {string} base64Data - Base64エンコードされた音声データ。
     * @param {string} contentType - 元のコンテンツタイプ。
     * @param {string} targetFormat - 目的の音声フォーマット ('wav', 'mp3'など)。
     * @returns {Promise<Blob>} 処理後の音声Blob。
     */
    async function processServerResponseAudio(base64Data, contentType, targetFormat) {
        const rawBlob = base64toBlob(base64Data, contentType);
        // FLACで受け取ってWAVで出力したい場合、デコードする
        if (targetFormat === 'wav' && (contentType.includes('flac') || contentType.includes('x-flac'))) {
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

    /**
     * 複数の音声Blobを単純に連結します。無音区間も挿入できます。
     * @param {Blob[]} blobs - 結合するBlobの配列。
     * @param {number[]} intervals - 各音声の後に挿入する無音区間の長さ（秒）の配列。
     * @param {string} format - 出力フォーマット ('wav', 'mp3'など)。
     * @returns {Promise<Blob|null>} 結合されたBlob。
     */
    async function combineAudioBlobs(blobs, intervals, format) {
        if (!blobs || blobs.length === 0) return null;
        const combinedParts = [];
        const targetFormat = format === 'wav' ? 'wav' : 'mp3'; // Opus/FLACは単純結合が難しいためMP3/WAVに集約

        for (let i = 0; i < blobs.length; i++) {
            combinedParts.push(blobs[i]);
            if (i < intervals.length && intervals[i] > 0) {
                const silence = createSilence(intervals[i], targetFormat);
                if (silence) combinedParts.push(silence);
            }
        }

        if (targetFormat === 'mp3') return await mergeMp3Blobs(combinedParts);
        if (targetFormat === 'wav') return await mergeWavBlobs(combinedParts);
        
        // フォールバック
        return new Blob(combinedParts, { type: FORMAT_MAPPING[format]?.contentType || blobs[0].type });
    }

    /**
     * 高度な音声結合処理を行います（オーバーラップ、ミキシング対応）。
     * 出力は常にWAVになります。
     * @param {object[]} validAudios - { blob: Blob, text: string } の配列。
     * @param {number[]} intervals - 各音声間の間隔（秒）。負の値でオーバーラップ。
     * @returns {Promise<{combinedBlob: Blob, finalFormat: string}>} 結合結果。
     */
    async function createAdvancedCombinedAudio(validAudios, intervals) {
        const blobs = validAudios.map(a => a.blob);
        const hasNegativeInterval = intervals.some(interval => interval < 0);
        const hasPositiveInterval = intervals.some(interval => interval > 0);

        // 間隔調整やオーバーラップがある場合は、デコードしてWAVとして再構築する
        if (hasNegativeInterval || hasPositiveInterval) {
            const decodedBuffers = await Promise.all(blobs.map(blob => blob.arrayBuffer().then(buffer => audioContextForDecoding.decodeAudioData(buffer))));
            const sampleRate = decodedBuffers[0].sampleRate;
            const numberOfChannels = Math.max(...decodedBuffers.map(b => b.numberOfChannels));

            // 各音声の開始位置をサンプル数で計算
            const startOffsetsInSamples = [0];
            for (let i = 0; i < intervals.length; i++) {
                const prevBufferLength = decodedBuffers[i].length;
                const intervalInSamples = Math.round(intervals[i] * sampleRate);
                const nextOffset = startOffsetsInSamples[i] + prevBufferLength + intervalInSamples;
                startOffsetsInSamples.push(nextOffset);
            }
            
            const minOffset = Math.min(...startOffsetsInSamples);
            let totalLengthInSamples = 0;
            let offsetShift = 0;

            if (minOffset < 0) { // 開始がマイナスになる場合は全体をずらす
                offsetShift = -minOffset;
            }

            for(let i=0; i<startOffsetsInSamples.length; i++) {
                startOffsetsInSamples[i] += offsetShift;
                if(decodedBuffers[i]){
                    const endPosition = startOffsetsInSamples[i] + decodedBuffers[i].length;
                    totalLengthInSamples = Math.max(totalLengthInSamples, endPosition);
                }
            }

            const mergedBuffer = audioContextForDecoding.createBuffer(numberOfChannels, totalLengthInSamples, sampleRate);

            // 各バッファをマージ
            for (let i = 0; i < decodedBuffers.length; i++) {
                const bufferToMix = decodedBuffers[i];
                const offset = startOffsetsInSamples[i];
                for (let channel = 0; channel < numberOfChannels; channel++) {
                    if (channel < bufferToMix.numberOfChannels) {
                        const outputData = mergedBuffer.getChannelData(channel);
                        const inputData = bufferToMix.getChannelData(channel);
                        for (let j = 0; j < inputData.length; j++) {
                            const outputIndex = offset + j;
                            if (outputIndex >= 0 && outputIndex < totalLengthInSamples) {
                                outputData[outputIndex] += inputData[j]; // ミキシング
                            }
                        }
                    }
                }
            }

            // 音割れ防止のためのノーマライズ
            let maxAmplitude = 0;
            for (let channel = 0; channel < numberOfChannels; channel++) {
                const channelData = mergedBuffer.getChannelData(channel);
                for (let i = 0; i < channelData.length; i++) {
                    maxAmplitude = Math.max(maxAmplitude, Math.abs(channelData[i]));
                }
            }

            if (maxAmplitude > 1.0) {
                const gain = 1.0 / maxAmplitude;
                for (let channel = 0; channel < numberOfChannels; channel++) {
                    const channelData = mergedBuffer.getChannelData(channel);
                    for (let i = 0; i < channelData.length; i++) {
                        channelData[i] *= gain;
                    }
                }
            }

            const combinedBlob = audioBufferToWav(mergedBuffer);
            return { combinedBlob, finalFormat: 'wav' };

        } else {
            // 単純な連結
            const outputFormat = blobs[0].type.includes('wav') ? 'wav' : 'mp3';
            const combinedBlob = await combineAudioBlobs(blobs, [], outputFormat);
            return { combinedBlob, finalFormat: outputFormat };
        }
    }


    // --- モジュールの公開API ---
    return {
        FORMAT_MAPPING,
        processServerResponseAudio,
        combineAudioBlobs,
        createAdvancedCombinedAudio
    };

})();