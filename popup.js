let allMedia = [];
let currentTypeFilter = 'all';  // 'all' | 'images' | 'videos'
let currentSizeFilter = 'all';  // 'all' | 'large' | 'medium'  (images only)
let currentTabId = null;
const blobCache = new Map();   // original url -> object URL
const downloadedSet = new Set();

// ---------------------------------------------------------------------------
// Minimal ZIP builder — store mode (no compression).
// Images and videos are already compressed; re-compressing wastes time.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c;
    }
    return t;
})();

function crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(files) {
    const enc = new TextEncoder();
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const { name, data } of files) {
        const nameBytes = enc.encode(name);
        const checksum = crc32(data);
        const size = data.length;

        const local = new Uint8Array(30 + nameBytes.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034B50, true);
        lv.setUint16(4, 20, true);
        lv.setUint16(6, 0, true);
        lv.setUint16(8, 0, true);
        lv.setUint16(10, 0, true);
        lv.setUint16(12, 0, true);
        lv.setUint32(14, checksum, true);
        lv.setUint32(18, size, true);
        lv.setUint32(22, size, true);
        lv.setUint16(26, nameBytes.length, true);
        lv.setUint16(28, 0, true);
        local.set(nameBytes, 30);

        locals.push(local, data);

        const central = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(central.buffer);
        cv.setUint32(0, 0x02014B50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, 0, true);
        cv.setUint16(14, 0, true);
        cv.setUint32(16, checksum, true);
        cv.setUint32(20, size, true);
        cv.setUint32(24, size, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint16(30, 0, true);
        cv.setUint16(32, 0, true);
        cv.setUint16(34, 0, true);
        cv.setUint16(36, 0, true);
        cv.setUint32(38, 0, true);
        cv.setUint32(42, offset, true);
        central.set(nameBytes, 46);

        centrals.push(central);
        offset += local.length + data.length;
    }

    const centralSize = centrals.reduce((s, c) => s + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054B50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    const parts = [...locals, ...centrals, eocd];
    const total = parts.reduce((s, p) => s + p.length, 0);
    const zip = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) { zip.set(p, pos); pos += p.length; }
    return zip;
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
    const minSizeInput = document.getElementById('min-size');

    // Type filter
    document.querySelectorAll('#type-filter-row .filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#type-filter-row .filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentTypeFilter = btn.dataset.type;

            // Size filter only meaningful for images
            document.querySelectorAll('#size-filter-row .filter-btn').forEach(b => {
                b.disabled = currentTypeFilter === 'videos';
            });

            applyFilter();
        });
    });

    // Size filter
    document.querySelectorAll('#size-filter-row .filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.disabled) return;
            document.querySelectorAll('#size-filter-row .filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentSizeFilter = btn.dataset.size;
            applyFilter();
        });
    });

    document.getElementById('download-all-btn').addEventListener('click', downloadVisibleAsZip);
    document.getElementById('refresh-btn').addEventListener('click', () => {
        allMedia = [];
        downloadedSet.clear();
        blobCache.forEach(u => URL.revokeObjectURL(u));
        blobCache.clear();
        document.getElementById('media-container').innerHTML = '';
        scan();
    });

    minSizeInput.addEventListener('change', scan);
    scan();
});

window.addEventListener('unload', () => {
    blobCache.forEach(u => URL.revokeObjectURL(u));
    blobCache.clear();
});

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

function scan() {
    const minSize = Math.max(0, parseInt(document.getElementById('min-size').value, 10) || 0);
    showStatus('Scanning page for images and videos...', 'loading');

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        currentTabId = tab.id;

        if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
            showStatus('Cannot access browser pages. Try on a regular website.', 'error');
            return;
        }

        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            function: extractMediaURLs,
            args: [minSize]
        }, (results) => {
            if (chrome.runtime.lastError) {
                showStatus('Script injection failed: ' + chrome.runtime.lastError.message, 'error');
                return;
            }

            if (results?.[0]?.result) {
                allMedia = results[0].result;
                if (allMedia.length === 0) {
                    showStatus('No images or videos found on this page.', 'error');
                } else {
                    const imgs = allMedia.filter(m => m.type === 'image').length;
                    const vids = allMedia.filter(m => m.type === 'video').length;
                    const parts = [];
                    if (imgs) parts.push(`${imgs} image${imgs !== 1 ? 's' : ''}`);
                    if (vids) parts.push(`${vids} video${vids !== 1 ? 's' : ''}`);
                    showStatus(`Found ${parts.join(' and ')}. Click to download.`, 'success');
                    displayMedia(allMedia);
                }
            } else {
                showStatus('Could not extract media. The page may have restricted access.', 'error');
            }
        });
    });
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

function applyFilter() {
    const container = document.getElementById('media-container');
    let visibleCount = 0;
    let downloadedVisible = 0;

    container.querySelectorAll('.media-item').forEach(item => {
        const index = parseInt(item.dataset.index, 10);
        const m = allMedia[index];
        let show = true;

        // Type filter
        if (currentTypeFilter === 'images') show = m.type === 'image';
        else if (currentTypeFilter === 'videos') show = m.type === 'video';

        // Size filter — only applied to images when we're not in Videos-only mode
        if (show && m.type === 'image' && currentTypeFilter !== 'videos') {
            if (currentSizeFilter === 'large') {
                show = m.width >= 500 || m.height >= 500;
            } else if (currentSizeFilter === 'medium') {
                show = (m.width >= 200 && m.width < 500) || (m.height >= 200 && m.height < 500);
            }
        }

        item.classList.toggle('hidden', !show);
        if (show) {
            visibleCount++;
            if (downloadedSet.has(index)) downloadedVisible++;
        }
    });

    const suffix = downloadedVisible > 0 ? ` · ${downloadedVisible} downloaded` : '';
    showStatus(`Showing ${visibleCount} of ${allMedia.length}${suffix}`, 'success');
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

function displayMedia(mediaList) {
    const container = document.getElementById('media-container');
    container.innerHTML = '';

    mediaList.forEach((m, index) => {
        const { url, type } = m;
        const item = document.createElement('div');
        item.className = 'media-item loading';
        item.dataset.index = index;
        item.title = buildTitle(m);

        if (type === 'video') {
            renderVideoCard(item, m, index);
        } else {
            renderImageCard(item, m, index);
        }

        const overlay = document.createElement('div');
        overlay.className = 'download-overlay';
        overlay.textContent = '⬇️';
        item.appendChild(overlay);

        item.addEventListener('click', () => downloadSingle(m, index, item));

        item.addEventListener('contextmenu', e => {
            e.preventDefault();
            navigator.clipboard.writeText(url)
                .then(() => showToast('URL copied'))
                .catch(() => showToast('Failed to copy URL'));
        });

        container.appendChild(item);
    });
}

function buildTitle(m) {
    const dim = m.width > 0 ? `${m.width}×${m.height}` : 'Unknown size';
    const dur = m.duration > 0 ? ` · ${formatDuration(m.duration)}` : '';
    return `${dim}${dur} · Click to download · Right-click to copy URL`;
}

function renderImageCard(item, m, index) {
    const placeholder = document.createElement('div');
    placeholder.className = 'placeholder';
    placeholder.textContent = index + 1;
    item.appendChild(placeholder);

    const sizeBadge = document.createElement('div');
    sizeBadge.className = 'size-badge';
    sizeBadge.textContent = m.width > 0 ? `${m.width}×${m.height}` : '?';
    item.appendChild(sizeBadge);

    const img = document.createElement('img');
    img.alt = `Image ${index + 1}`;

    if (m.url.startsWith('data:')) {
        img.src = m.url;
        img.onload = () => {
            item.classList.remove('loading');
            placeholder.remove();
            item.insertBefore(img, item.firstChild);
        };
    } else {
        fetchAndCacheBlob(m.url)
            .then(blobUrl => {
                img.src = blobUrl;
                img.onload = () => {
                    item.classList.remove('loading');
                    placeholder.remove();
                    item.insertBefore(img, item.firstChild);
                };
            })
            .catch(() => {
                item.classList.remove('loading');
                item.classList.add('no-preview');
            });
    }
}

function renderVideoCard(item, m, index) {
    item.classList.remove('loading');

    const vp = document.createElement('div');
    vp.className = 'video-placeholder';

    const playIcon = document.createElement('div');
    playIcon.className = 'video-play-icon';
    playIcon.textContent = '▶';
    vp.appendChild(playIcon);

    const formatLabel = document.createElement('div');
    formatLabel.className = 'video-format-label';
    formatLabel.textContent = m.extension.toUpperCase();
    vp.appendChild(formatLabel);

    item.appendChild(vp);

    // Size/duration badge
    const badge = document.createElement('div');
    badge.className = 'size-badge';
    if (m.width > 0) {
        badge.textContent = m.duration > 0
            ? `${m.width}×${m.height} · ${formatDuration(m.duration)}`
            : `${m.width}×${m.height}`;
    } else if (m.duration > 0) {
        badge.textContent = formatDuration(m.duration);
    } else {
        badge.textContent = m.extension.toUpperCase();
    }
    item.appendChild(badge);

}

function formatDuration(secs) {
    if (!secs || isNaN(secs) || !isFinite(secs)) return '';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Download — single item
// ---------------------------------------------------------------------------

function downloadSingle(m, index, itemEl) {
    const filename = deriveFilename(m.url, index, m.type, m.extension);

    const doDownload = (downloadUrl) => {
        chrome.downloads.download({ url: downloadUrl, filename, saveAs: false }, () => {
            if (chrome.runtime.lastError) {
                showToast('Download failed: ' + chrome.runtime.lastError.message);
            } else {
                downloadedSet.add(index);
                itemEl.classList.add('downloaded');
                applyFilter();
            }
        });
    };

    if (m.url.startsWith('data:')) { doDownload(m.url); return; }
    if (blobCache.has(m.url)) { doDownload(blobCache.get(m.url)); return; }

    fetchAndCacheBlob(m.url)
        .then(doDownload)
        .catch(() => {
            showToast('Fetch failed, trying direct download...');
            doDownload(m.url);
        });
}

// ---------------------------------------------------------------------------
// Download — visible items as ZIP
// ---------------------------------------------------------------------------

async function downloadVisibleAsZip() {
    const container = document.getElementById('media-container');
    const visibleItems = [...container.querySelectorAll('.media-item:not(.hidden)')];

    if (visibleItems.length === 0) {
        showToast('No visible items to download');
        return;
    }

    const downloadBtn = document.getElementById('download-all-btn');
    const refreshBtn  = document.getElementById('refresh-btn');
    downloadBtn.disabled = true;
    refreshBtn.disabled  = true;

    // Separate into two buckets up front
    const imageItems = [];
    const videoItems = [];

    visibleItems.forEach(item => {
        const index = parseInt(item.dataset.index, 10);
        const m = allMedia[index];
        if (m.type === 'video') videoItems.push({ item, index, m });
        else                    imageItems.push({ item, index, m });
    });

    // ── Images → ZIP ──────────────────────────────────────────────────────────
    const files = [];
    let failedImages = 0;
    const usedNames  = new Map();

    for (let i = 0; i < imageItems.length; i++) {
        const { item, index, m } = imageItems[i];
        showStatus(`Fetching image ${i + 1} of ${imageItems.length}...`, 'loading');
        try {
            const data = await fetchAsUint8Array(m.url);
            files.push({ name: uniqueName(deriveFilename(m.url, index, 'image', m.extension), usedNames), data });
        } catch {
            failedImages++;
        }
    }

    downloadBtn.disabled = false;
    refreshBtn.disabled  = false;

    // Trigger ZIP if we have any images
    if (files.length > 0) {
        showStatus(`Packaging ${files.length} image(s) into ZIP...`, 'loading');
        const zipData = buildZip(files);
        const zipBlob = new Blob([zipData], { type: 'application/zip' });
        const zipUrl  = URL.createObjectURL(zipBlob);

        await new Promise(resolve => {
            chrome.downloads.download({
                url: zipUrl,
                filename: `instaloader_${Date.now()}.zip`,
                saveAs: false
            }, () => {
                URL.revokeObjectURL(zipUrl);
                if (chrome.runtime.lastError) {
                    showToast('ZIP download failed: ' + chrome.runtime.lastError.message);
                } else {
                    imageItems.forEach(({ item, index }) => {
                        downloadedSet.add(index);
                        item.classList.add('downloaded');
                    });
                }
                resolve();
            });
        });
    }

    // ── Videos → individual downloads via Chrome's download manager ───────────
    // Videos can be hundreds of MB — loading them into memory for a ZIP would
    // exhaust the popup's heap. Chrome's download manager handles large files,
    // byte-range requests, and auth cookies correctly.
    let failedVideos = 0;
    for (const { item, index, m } of videoItems) {
        const filename = uniqueName(deriveFilename(m.url, index, 'video', m.extension), usedNames);
        await new Promise(resolve => {
            chrome.downloads.download({ url: m.url, filename, saveAs: false }, () => {
                if (chrome.runtime.lastError) {
                    failedVideos++;
                } else {
                    downloadedSet.add(index);
                    item.classList.add('downloaded');
                }
                resolve();
            });
        });
    }

    // ── Final status ─────────────────────────────────────────────────────────
    const parts = [];
    if (files.length > 0)      parts.push(`${files.length} image(s) as ZIP`);
    if (videoItems.length > 0) parts.push(`${videoItems.length - failedVideos} video(s) individually`);

    const notes = [];
    if (failedImages > 0) notes.push(`${failedImages} image(s) failed`);
    if (failedVideos > 0) notes.push(`${failedVideos} video(s) failed`);

    if (parts.length === 0) {
        showStatus('Nothing could be downloaded.', 'error');
    } else {
        const suffix = notes.length ? ` (${notes.join(', ')})` : '';
        showStatus(`Downloaded ${parts.join(' + ')}${suffix}.`, 'success');
    }

    applyFilter();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveFilename(url, index, type, extension) {
    const prefix = type === 'video' ? 'video' : 'image';
    const VALID_EXTS = type === 'video'
        ? new Set(['mp4','webm','ogg','mov','m4v','ogv','avi','mkv'])
        : new Set(['jpg','jpeg','png','gif','webp','svg','bmp','ico','avif']);

    if (url.startsWith('data:') || url.startsWith('blob:')) {
        return `${prefix}_${index + 1}.${extension || (type === 'video' ? 'mp4' : 'jpg')}`;
    }
    try {
        const pathname = new URL(url).pathname;
        const name = pathname.split('/').filter(Boolean).pop() || '';
        if (name) {
            const dot = name.lastIndexOf('.');
            if (dot !== -1 && VALID_EXTS.has(name.slice(dot + 1).toLowerCase())) return name;
        }
    } catch {}
    return `${prefix}_${index + 1}.${extension || (type === 'video' ? 'mp4' : 'jpg')}`;
}

function uniqueName(name, usedMap) {
    if (!usedMap.has(name)) { usedMap.set(name, 1); return name; }
    const count = usedMap.get(name) + 1;
    usedMap.set(name, count);
    const dot = name.lastIndexOf('.');
    return dot === -1 ? `${name}_${count}` : `${name.slice(0, dot)}_${count}${name.slice(dot)}`;
}

async function fetchAndCacheBlob(url) {
    if (blobCache.has(url)) return blobCache.get(url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blobUrl = URL.createObjectURL(await res.blob());
    blobCache.set(url, blobUrl);
    return blobUrl;
}

async function fetchAsUint8Array(url) {
    if (url.startsWith('data:')) {
        return new Uint8Array(await (await fetch(url)).arrayBuffer());
    }
    const source = blobCache.get(url) || url;
    const res = await fetch(source);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
}

function showStatus(msg, type) {
    const el = document.getElementById('status');
    el.textContent = msg;
    el.className = `status ${type}`;
}

function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('visible'), 2500);
}

// ---------------------------------------------------------------------------
// Page-context script — runs inside the tab via chrome.scripting.executeScript.
// Returns a Promise (MV3 awaits it), allowing async background-image probing.
// ---------------------------------------------------------------------------

function extractMediaURLs(minSize) {
    const media = [];
    const seenUrls = new Set();

    function resolveUrl(url) {
        try { return new URL(url, document.baseURI).href; }
        catch { return url; }
    }

    function normalizeUrl(url) {
        try { const u = new URL(url, document.baseURI); return u.origin + u.pathname; }
        catch { return url; }
    }

    function dedupeKey(url) {
        if (url.startsWith('data:')) return url.substring(0, 100);
        if (url.startsWith('blob:')) return url;
        return normalizeUrl(url);
    }

    function getExtension(url, type) {
        if (url.startsWith('data:')) {
            const m = url.match(/^data:(?:image|video)\/(\w+)/);
            const ext = m ? m[1].toLowerCase() : (type === 'video' ? 'mp4' : 'jpg');
            return ext === 'jpeg' ? 'jpg' : ext;
        }
        if (url.startsWith('blob:')) return type === 'video' ? 'mp4' : 'jpg';
        try {
            const m = new URL(url, document.baseURI).pathname.match(/\.(\w+)(?:[?#]|$)/);
            if (m) {
                const ext = m[1].toLowerCase();
                const known = ['jpg','jpeg','png','gif','webp','svg','bmp','ico','avif',
                               'mp4','webm','ogg','mov','m4v','ogv','avi','mkv'];
                if (known.includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
            }
        } catch {}
        return type === 'video' ? 'mp4' : 'jpg';
    }

    const DOC_EXTS = new Set(['htm','html','xhtml','php','asp','aspx','jsp','cfm','xml','json','txt','pdf']);

    function addItem(url, width, height, type, extra = {}) {
        if (!url) return;
        const isBlob = url.startsWith('blob:');
        if (!isBlob && !url.startsWith('data:')) url = resolveUrl(url);

        // Drop non-http(s) URLs and document-extension URLs
        if (!isBlob && !url.startsWith('data:')) {
            try {
                const parsed = new URL(url);
                if (!['http:', 'https:'].includes(parsed.protocol)) return;
                const ext = parsed.pathname.split('.').pop().split('?')[0].toLowerCase();
                if (DOC_EXTS.has(ext)) return;
            } catch { return; } // unparseable URL → skip
        }

        const key = dedupeKey(url);
        if (seenUrls.has(key)) return;

        // Apply minSize only to images with known dimensions
        if (type === 'image' && width > 0 && height > 0 && (width < minSize || height < minSize)) return;

        seenUrls.add(key);
        media.push({ url, width, height, type, isBlob, extension: getExtension(url, type), ...extra });
    }

    function getBestFromSrcset(srcset) {
        if (!srcset) return null;
        let bestUrl = null, maxW = -1;
        srcset.split(',').forEach(part => {
            const tokens = part.trim().split(/\s+/);
            if (!tokens[0]) return;
            let w = 0;
            if (tokens[1]) {
                if (tokens[1].endsWith('w')) w = parseInt(tokens[1]) || 0;
                else if (tokens[1].endsWith('x')) w = parseFloat(tokens[1]) * 1000 || 0;
            }
            if (w > maxW) { maxW = w; bestUrl = tokens[0]; }
        });
        return bestUrl;
    }

    // ── Images: <img> elements ──
    document.querySelectorAll('img').forEach(img => {
        // img.complete + naturalWidth===0 means the browser tried and failed — skip it.
        // (Lazy-not-yet-loaded images have complete===false, so they're unaffected.)
        if (img.complete && img.naturalWidth === 0 && img.src && !img.src.startsWith('data:')) return;

        let url = img.currentSrc || img.src || '';
        const w = img.naturalWidth  || parseInt(img.getAttribute('width'))  || 0;
        const h = img.naturalHeight || parseInt(img.getAttribute('height')) || 0;

        const srcsetUrl = getBestFromSrcset(img.srcset);
        if (srcsetUrl) url = srcsetUrl;

        if (!url || url.startsWith('data:')) {
            url = img.dataset.src || img.dataset.lazySrc || img.dataset.original
               || img.dataset.srcLarge || img.dataset.bg || img.dataset.image
               || img.dataset.fullSrc || img.getAttribute('data-original-src')
               || img.getAttribute('data-hi-res-src') || '';
        }

        if (url) addItem(url, w, h, 'image');
    });

    // ── Images: <picture> <source> elements ──
    document.querySelectorAll('picture source').forEach(source => {
        const url = getBestFromSrcset(source.srcset)
            || source.srcset?.split(',')[0]?.trim().split(/\s+/)[0];
        if (!url) return;
        const si = source.closest('picture')?.querySelector('img');
        const w = si?.naturalWidth  || parseInt(si?.getAttribute('width'))  || 0;
        const h = si?.naturalHeight || parseInt(si?.getAttribute('height')) || 0;
        addItem(url, w, h, 'image');
    });

    // ── Images: CSS background-image (async probe for real dimensions) ──
    const bgUrls = new Set();
    document.querySelectorAll('*').forEach(el => {
        const bg = getComputedStyle(el).backgroundImage;
        if (!bg || bg === 'none') return;
        (bg.match(/url\(["']?([^"')]+)["']?\)/g) || []).forEach(m => {
            const raw = m.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
            if (raw && !raw.startsWith('data:')) bgUrls.add(raw);
        });
    });

    const bgProbes = [...bgUrls].map(rawUrl => new Promise(resolve => {
        const resolved = resolveUrl(rawUrl);
        const probe = new Image();
        probe.onload  = () => resolve({ url: resolved, width: probe.naturalWidth, height: probe.naturalHeight });
        probe.onerror = () => resolve({ url: resolved, width: 0, height: 0 });
        probe.src = resolved;
        // Safety net: images already in browser cache resolve near-instantly
        setTimeout(() => resolve({ url: resolved, width: 0, height: 0 }), 1500);
    }));

    // ── Videos: <video> elements ──
    const videoMediaExts = ['mp4','webm','ogg','mov','m4v','ogv','avi','mkv'];
    function isDirectVideoUrl(url) {
        if (!url || url.startsWith('blob:') || url.startsWith('data:')) return false;
        try {
            const pathname = new URL(url, document.baseURI).pathname.toLowerCase();
            const ext = pathname.split('.').pop().split('?')[0];
            return videoMediaExts.includes(ext);
        } catch { return false; }
    }

    const videoItems = [];
    document.querySelectorAll('video').forEach(video => {
        const src = video.currentSrc || video.src || '';
        const w = video.videoWidth  || parseInt(video.getAttribute('width'))  || 0;
        const h = video.videoHeight || parseInt(video.getAttribute('height')) || 0;
        const duration = isFinite(video.duration) ? video.duration : 0;

        if (isDirectVideoUrl(src)) {
            videoItems.push({ url: src, width: w, height: h, duration });
        }

        // <source> children — alternative direct URLs not yet played
        video.querySelectorAll('source').forEach(source => {
            const ssrc = source.src || '';
            if (ssrc && ssrc !== src && isDirectVideoUrl(ssrc)) {
                videoItems.push({ url: ssrc, width: w, height: h, duration });
            }
        });
    });

    return Promise.all(bgProbes).then(bgResults => {
        bgResults.forEach(({ url, width, height }) => {
            if (width > 0 && height > 0) addItem(url, width, height, 'image');
        });

        videoItems.forEach(({ url, width, height, duration }) => {
            addItem(url, width, height, 'video', { duration });
        });

        // Largest images first, then videos
        const images = media.filter(m => m.type === 'image');
        const videos = media.filter(m => m.type === 'video');
        images.sort((a, b) => (b.width * b.height) - (a.width * a.height));

        return [...images, ...videos];
    });
}
