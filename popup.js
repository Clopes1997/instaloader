let allImages = [];
let currentFilter = 'all';

document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('images-container');
    const statusEl = document.getElementById('status');
    
    // Setup filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            applyFilter();
        });
    });
    
    // Show loading state
    statusEl.textContent = 'Scanning page for images...';
    statusEl.className = 'status loading';
    
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const currentTab = tabs[0];
        
        // Check if we're on a valid page
        if (!currentTab.url || currentTab.url.startsWith('chrome://') || currentTab.url.startsWith('edge://')) {
            showError('Cannot access browser pages. Try on a regular website.');
            return;
        }
        
        chrome.scripting.executeScript({
            target: { tabId: currentTab.id },
            function: extractImageURLs
        }, (results) => {
            // Check for Chrome runtime errors
            if (chrome.runtime.lastError) {
                showError('Script injection failed: ' + chrome.runtime.lastError.message);
                return;
            }
            
            if (results && results[0] && results[0].result) {
                allImages = results[0].result;
                
                if (allImages.length === 0) {
                    showError('No images found on this page.');
                } else {
                    statusEl.textContent = `Found ${allImages.length} image(s). Click to download.`;
                    statusEl.className = 'status success';
                    displayImages(allImages);
                }
            } else {
                showError('Could not extract images. The page may have restricted access.');
            }
        });
    });
    
    function showError(message) {
        statusEl.textContent = message;
        statusEl.className = 'status error';
    }
});

function applyFilter() {
    const container = document.getElementById('images-container');
    const items = container.querySelectorAll('.image-item');
    let visibleCount = 0;
    
    items.forEach((item, index) => {
        const imgData = allImages[index];
        let show = true;
        
        if (currentFilter === 'large') {
            show = imgData.width >= 500 || imgData.height >= 500;
        } else if (currentFilter === 'medium') {
            show = (imgData.width >= 200 && imgData.width < 500) || (imgData.height >= 200 && imgData.height < 500);
        }
        
        item.classList.toggle('hidden', !show);
        if (show) visibleCount++;
    });
    
    const statusEl = document.getElementById('status');
    statusEl.textContent = `Showing ${visibleCount} of ${allImages.length} image(s)`;
}

function displayImages(images) {
    const container = document.getElementById('images-container');
    container.innerHTML = '';
    
    images.forEach((imgData, index) => {
        const url = imgData.url;
        const imgDiv = document.createElement('div');
        imgDiv.className = 'image-item loading';
        imgDiv.title = `${imgData.width}×${imgData.height} - Click to download`;

        const img = document.createElement('img');
        img.alt = `Image ${index + 1}`;
        
        // Show loading placeholder with number
        const placeholder = document.createElement('div');
        placeholder.className = 'placeholder';
        placeholder.textContent = index + 1;
        imgDiv.appendChild(placeholder);
        
        // Size badge
        const sizeBadge = document.createElement('div');
        sizeBadge.className = 'size-badge';
        sizeBadge.textContent = `${imgData.width}×${imgData.height}`;
        imgDiv.appendChild(sizeBadge);

        // Fetch image as blob to bypass CORS for thumbnail display
        fetchImageAsBlob(url)
            .then(blobUrl => {
                img.src = blobUrl;
                img.onload = () => {
                    imgDiv.classList.remove('loading');
                    placeholder.remove();
                    imgDiv.insertBefore(img, imgDiv.firstChild);
                };
            })
            .catch(() => {
                imgDiv.classList.remove('loading');
                imgDiv.classList.add('no-preview');
            });

        const overlay = document.createElement('div');
        overlay.className = 'download-overlay';
        overlay.innerHTML = '⬇️';

        imgDiv.appendChild(overlay);
        container.appendChild(imgDiv);

        imgDiv.addEventListener('click', () => {
            downloadImage(url, index, imgData.extension);
            imgDiv.classList.add('downloaded');
        });
    });
}

// Fetch image as blob to bypass CORS restrictions for display
async function fetchImageAsBlob(url) {
    const response = await fetch(url, { mode: 'cors' });
    if (!response.ok) throw new Error('Fetch failed');
    const blob = await response.blob();
    return URL.createObjectURL(blob);
}

function downloadImage(url, index, extension) {
    const timestamp = Date.now();
    const ext = extension || 'jpg';
    const filename = `image_${timestamp}_${index + 1}.${ext}`;
    
    // Fetch and download as blob to bypass CORS issues
    fetch(url)
        .then(response => response.blob())
        .then(blob => {
            const blobUrl = URL.createObjectURL(blob);
            chrome.downloads.download({
                url: blobUrl,
                filename: filename,
                saveAs: false
            }, (downloadId) => {
                if (chrome.runtime.lastError) {
                    console.error('Download failed:', chrome.runtime.lastError.message);
                    // Fallback: try direct download
                    chrome.downloads.download({ url: url, filename: filename });
                } else {
                    console.log('Download started:', downloadId);
                }
                setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
            });
        })
        .catch(err => {
            console.error('Fetch failed:', err);
            chrome.downloads.download({ url: url, filename: filename });
        });
}

// This function runs in the context of the webpage
function extractImageURLs() {
    const images = [];
    const seenUrls = new Set();
    
    // Helper to get file extension from URL
    function getExtension(url) {
        try {
            const pathname = new URL(url).pathname;
            const match = pathname.match(/\.(\w+)$/);
            if (match) {
                const ext = match[1].toLowerCase();
                if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) {
                    return ext === 'jpeg' ? 'jpg' : ext;
                }
            }
        } catch {}
        return 'jpg';
    }
    
    // Helper to normalize URL for deduplication
    function normalizeUrl(url) {
        try {
            const u = new URL(url);
            return u.origin + u.pathname;
        } catch {
            return url;
        }
    }
    
    // Helper to add image if valid
    function addImage(url, width, height) {
        if (!url || url.startsWith('data:')) return;
        
        const normalizedUrl = normalizeUrl(url);
        if (seenUrls.has(normalizedUrl)) return;
        
        // Skip very small images (likely icons/spacers)
        if (width < 50 || height < 50) return;
        
        seenUrls.add(normalizedUrl);
        images.push({
            url: url,
            width: width,
            height: height,
            extension: getExtension(url)
        });
    }
    
    // Get best URL from srcset
    function getBestFromSrcset(srcset) {
        if (!srcset) return null;
        
        let bestUrl = null;
        let maxWidth = 0;
        
        const sources = srcset.split(',');
        sources.forEach(source => {
            const parts = source.trim().split(/\s+/);
            if (parts.length >= 1) {
                const url = parts[0];
                let width = 0;
                
                if (parts.length >= 2) {
                    const descriptor = parts[1];
                    if (descriptor.endsWith('w')) {
                        width = parseInt(descriptor);
                    } else if (descriptor.endsWith('x')) {
                        width = parseFloat(descriptor) * 1000;
                    }
                }
                
                if (width > maxWidth) {
                    maxWidth = width;
                    bestUrl = url;
                }
            }
        });
        
        return bestUrl;
    }
    
    // Process all img elements
    document.querySelectorAll('img').forEach(img => {
        let url = img.src;
        let width = img.naturalWidth || img.width || 0;
        let height = img.naturalHeight || img.height || 0;
        
        // Try to get higher resolution from srcset
        const srcsetUrl = getBestFromSrcset(img.srcset);
        if (srcsetUrl) {
            url = srcsetUrl;
        }
        
        // Check data attributes for lazy-loaded images
        if (!url || url.startsWith('data:')) {
            url = img.dataset.src || img.dataset.lazySrc || img.dataset.original || img.dataset.srcLarge;
        }
        
        if (url) {
            addImage(url, width, height);
        }
    });
    
    // Process picture elements (responsive images)
    document.querySelectorAll('picture source').forEach(source => {
        const srcset = source.srcset;
        const url = getBestFromSrcset(srcset) || srcset?.split(',')[0]?.trim().split(/\s+/)[0];
        if (url) {
            // Estimate size from media query or default
            addImage(url, 800, 600);
        }
    });
    
    // Process background images
    document.querySelectorAll('*').forEach(el => {
        const style = getComputedStyle(el);
        const bgImage = style.backgroundImage;
        
        if (bgImage && bgImage !== 'none') {
            const matches = bgImage.match(/url\(["']?([^"')]+)["']?\)/g);
            if (matches) {
                matches.forEach(match => {
                    const url = match.replace(/url\(["']?/, '').replace(/["']?\)$/, '');
                    if (url && !url.startsWith('data:')) {
                        const rect = el.getBoundingClientRect();
                        addImage(url, Math.round(rect.width) || 200, Math.round(rect.height) || 200);
                    }
                });
            }
        }
    });
    
    // Sort by size (largest first)
    images.sort((a, b) => (b.width * b.height) - (a.width * a.height));
    
    return images;
}
