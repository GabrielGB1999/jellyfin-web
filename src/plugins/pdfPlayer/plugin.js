import React from 'react';
import alert from '../../components/alert';
import loading from '../../components/loading/loading';
import globalize from '../../lib/globalize';
import keyboardnavigation from '../../scripts/keyboardNavigation';
import dialogHelper from '../../components/dialogHelper/dialogHelper';
import TouchHelper from '../../scripts/touchHelper';
import { appRouter } from '../../components/router/appRouter';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import * as userSettings from '../../scripts/settings/userSettings';
import { PluginType } from '../../types/plugin.ts';
import Events from '../../utils/events.ts';
import PdfOsd from './PdfOsd';
import { PdfPageSlider, PdfToolbar } from './PdfControls';
import { renderComponent } from '../../utils/reactUtils';

import 'material-design-icons-iconfont';
import './style.scss';

const VIEW_MODES = ['single', 'spread', 'continuous'];
const VIEW_MODE_SETTING = 'pdfPlayerViewMode';

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;
const ZOOM_STEP = 1.25;
// Zoom factor applied per pixel of wheel delta, one mouse wheel notch (~100px) zooms ~20%
const WHEEL_ZOOM_SPEED = Math.log(1.2) / 100;
// Zoom level a double tap switches to when the pages fit the screen
const DOUBLE_TAP_ZOOM = 2;
// Max time and distance between two taps for them to count as a double tap
const DOUBLE_TAP_DELAY = 300;
const DOUBLE_TAP_DISTANCE = 30;
// Max finger movement for a touch to count as a tap
const TAP_MAX_MOVE = 10;

// Gap between pages and around the page area, in CSS pixels
const PAGE_GAP = 16;
// Continuous mode fits the page width, but caps it so pages stay readable on wide screens
const CONTINUOUS_MAX_WIDTH = 1000;
// Upper bound for a single canvas, browsers fail to draw larger canvases
const MAX_CANVAS_PIXELS = 4096 * 4096;
// Number of pages rendered ahead of time in single page and spread modes
const PREFETCH_PAGES = 2;
const CANVAS_CACHE_SIZE = 8;
// Total canvas pixels kept in the cache, high zoom levels keep fewer pages around
const CANVAS_CACHE_PIXELS = 32 * 1024 * 1024;
const RERENDER_DELAY = 150;
// Size of the byte ranges requested from the server
const RANGE_CHUNK_SIZE = 256 * 1024;

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

export class PdfPlayer {
    constructor() {
        this.name = 'PDF Player';
        this.type = PluginType.MediaPlayer;
        this.id = 'pdfplayer';
        this.priority = 1;

        this.previous = this.previous.bind(this);
        this.next = this.next.bind(this);
        this.seek = this.seek.bind(this);
        this.zoomIn = this.zoomIn.bind(this);
        this.zoomOut = this.zoomOut.bind(this);
        this.resetZoom = this.resetZoom.bind(this);
        this.setViewMode = this.setViewMode.bind(this);
        this.getViewState = this.getViewState.bind(this);

        this.onDialogClosed = this.onDialogClosed.bind(this);
        this.onWindowKeyDown = this.onWindowKeyDown.bind(this);
        this.onWheel = this.onWheel.bind(this);
        this.onScroll = this.onScroll.bind(this);
        this.onPointerDown = this.onPointerDown.bind(this);
        this.onTouchStart = this.onTouchStart.bind(this);
        this.onTouchMove = this.onTouchMove.bind(this);
        this.onTouchEnd = this.onTouchEnd.bind(this);
        this.onResize = this.onResize.bind(this);
        this.toggleFullscreen = this.toggleFullscreen.bind(this);
    }

    play(options) {
        this.progress = 0;
        this.page = 1;
        this.zoom = 1;
        this.scale = 1;
        this.loaded = false;
        this.cancellationToken = false;
        this.pageSizes = [];
        this.pageElements = new Map();
        this.canvasCache = new Map();
        this.chapters = [];

        const viewMode = userSettings.get(VIEW_MODE_SETTING, false);
        this.viewMode = VIEW_MODES.includes(viewMode) ? viewMode : 'single';

        loading.show();

        const elem = this.createMediaElement(options);
        return this.setCurrentSrc(elem, options);
    }

    stop() {
        this.unbindEvents();
        this.unmountBookOsd?.();
        this.unmountBookOsd = null;

        const stopInfo = {
            src: this.item
        };

        Events.trigger(this, 'stopped', [stopInfo]);

        const elem = this.mediaElement;
        if (elem) {
            dialogHelper.close(elem);
            this.mediaElement = null;
        }

        // hide loading animation
        loading.hide();

        // cancel page render
        this.cancellationToken = true;
        this.loaded = false;
        clearTimeout(this.rerenderTimeout);
        this.releaseAllPages();
        this.canvasCache?.clear();
        this.book?.destroy();
        this.book = null;
    }

    destroy() {
        // Nothing to do here
    }

    currentItem() {
        return this.item;
    }

    currentTime() {
        return this.progress;
    }

    duration() {
        return this.book ? this.book.numPages : 0;
    }

    volume() {
        return 100;
    }

    isMuted() {
        return false;
    }

    paused() {
        return false;
    }

    seekable() {
        return true;
    }

    getViewState() {
        return {
            page: this.page || 1,
            numPages: this.duration(),
            zoom: this.zoom || 1,
            viewMode: this.viewMode || 'single',
            chapters: this.chapters || []
        };
    }

    notifyViewState() {
        Events.trigger(this, 'viewstatechange');
    }

    onWindowKeyDown(e) {
        if (!this.loaded) return;

        // Skip modified keys
        if (e.ctrlKey || e.altKey || e.metaKey) return;

        switch (e.key) {
            case '+':
            case '=':
                e.preventDefault();
                this.zoomIn();
                return;
            case '-':
                e.preventDefault();
                this.zoomOut();
                return;
            case '0':
                e.preventDefault();
                this.resetZoom();
                return;
        }

        if (e.shiftKey) return;

        const key = keyboardnavigation.getKeyName(e);

        switch (key) {
            case 'l':
            case 'ArrowRight':
            case 'Right':
                e.preventDefault();
                this.next();
                break;
            case 'j':
            case 'ArrowLeft':
            case 'Left':
                e.preventDefault();
                this.previous();
                break;
            case 'PageDown':
                if (this.viewMode !== 'continuous') {
                    e.preventDefault();
                    this.next();
                }
                break;
            case 'PageUp':
                if (this.viewMode !== 'continuous') {
                    e.preventDefault();
                    this.previous();
                }
                break;
            case 'Home':
                e.preventDefault();
                this.seek(1);
                break;
            case 'End':
                e.preventDefault();
                this.seek(this.duration());
                break;
            case 'Escape':
                e.preventDefault();
                this.stop();
                break;
        }
    }

    onWheel(e) {
        if (!this.loaded) return;

        // Pinch gestures on trackpads are reported as wheel events with the ctrl key set.
        // In page modes the wheel always zooms, in continuous mode it scrolls unless ctrl is held.
        if (!e.ctrlKey && this.viewMode === 'continuous') return;

        e.preventDefault();

        let delta = e.deltaY;
        if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
        else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= this.container.clientHeight;

        this.setZoom(this.zoom * Math.exp(-delta * WHEEL_ZOOM_SPEED), { x: e.clientX, y: e.clientY });
    }

    onScroll() {
        if (this.viewMode !== 'continuous' || this.scrollFrame) return;

        this.scrollFrame = requestAnimationFrame(() => {
            this.scrollFrame = null;
            this.updateCurrentPageFromScroll();
        });
    }

    onPointerDown(e) {
        const container = this.container;
        if (e.pointerType !== 'mouse' || e.button !== 0 || !container) return;
        if (container.scrollWidth <= container.clientWidth && container.scrollHeight <= container.clientHeight) return;

        // drag to pan zoomed pages
        const startX = e.clientX;
        const startY = e.clientY;
        const scrollLeft = container.scrollLeft;
        const scrollTop = container.scrollTop;
        let dragged = false;

        const onPointerMove = (event) => {
            const dx = event.clientX - startX;
            const dy = event.clientY - startY;
            if (!dragged && Math.abs(dx) + Math.abs(dy) < 5) return;

            dragged = true;
            container.classList.add('pdfDragging');
            container.scrollLeft = scrollLeft - dx;
            container.scrollTop = scrollTop - dy;
        };

        const onPointerUp = () => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            container.classList.remove('pdfDragging');

            if (dragged) {
                // prevent the click that ends the drag from toggling the OSD
                const onClick = event => event.stopPropagation();
                window.addEventListener('click', onClick, { capture: true, once: true });
                setTimeout(() => window.removeEventListener('click', onClick, { capture: true }));
            }
        };

        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
    }

    onTouchStart(e) {
        if (e.touches.length === 1) {
            // a new gesture starts, page swipes are allowed again
            this.pinch = null;
            this.pinched = false;
            const touch = e.touches[0];
            this.tapStart = { x: touch.clientX, y: touch.clientY };
        } else if (e.touches.length === 2 && this.loaded) {
            const [a, b] = e.touches;
            this.pinch = {
                distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
                zoom: this.zoom
            };
            this.pinched = true;
            this.tapStart = null;
        }
    }

    onTouchMove(e) {
        if (!this.pinch || e.touches.length !== 2) return;

        // the viewport disables native pinch zoom, so zoom the pages instead of scrolling them
        e.preventDefault();

        const [a, b] = e.touches;
        const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        this.setZoom(this.pinch.zoom * distance / this.pinch.distance, {
            x: (a.clientX + b.clientX) / 2,
            y: (a.clientY + b.clientY) / 2
        });
    }

    onTouchEnd(e) {
        if (e.touches.length < 2) this.pinch = null;
        if (e.type === 'touchcancel' || e.touches.length || !this.tapStart) return;

        const touch = e.changedTouches[0];
        const start = this.tapStart;
        this.tapStart = null;
        if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > TAP_MAX_MOVE) return;

        const last = this.lastTap;
        this.lastTap = { x: touch.clientX, y: touch.clientY, time: e.timeStamp };
        if (!last
            || e.timeStamp - last.time > DOUBLE_TAP_DELAY
            || Math.hypot(touch.clientX - last.x, touch.clientY - last.y) > DOUBLE_TAP_DISTANCE) return;

        // double tap zooms in on the tapped point, or back to fit the screen when zoomed in
        this.lastTap = null;
        this.setZoom(this.zoom > 1 ? 1 : DOUBLE_TAP_ZOOM, { x: touch.clientX, y: touch.clientY });
    }

    onResize() {
        clearTimeout(this.resizeTimeout);
        this.resizeTimeout = setTimeout(() => {
            if (this.loaded) this.layout();
        }, 100);
    }

    addSwipeGestures(element) {
        // only flip pages when the pages fit the screen, otherwise swiping pans the zoomed page,
        // and not when lifting the fingers of a pinch
        const canSwipe = () => this.viewMode !== 'continuous'
            && !this.pinched
            && this.container.scrollWidth <= this.container.clientWidth + 1;

        this.touchHelper = new TouchHelper(element);
        Events.on(this.touchHelper, 'swiperight', () => canSwipe() && this.previous());
        Events.on(this.touchHelper, 'swipeleft', () => canSwipe() && this.next());
    }

    onDialogClosed() {
        this.stop();
    }

    bindEvents() {
        this.addSwipeGestures(this.container);
        this.mediaElement?.addEventListener('close', this.onDialogClosed, { once: true });
        document.addEventListener('keydown', this.onWindowKeyDown);
        this.container.addEventListener('wheel', this.onWheel, { passive: false });
        this.container.addEventListener('scroll', this.onScroll, { passive: true });
        this.container.addEventListener('pointerdown', this.onPointerDown);
        this.container.addEventListener('touchstart', this.onTouchStart, { passive: true });
        this.container.addEventListener('touchmove', this.onTouchMove, { passive: false });
        this.container.addEventListener('touchend', this.onTouchEnd, { passive: true });
        this.container.addEventListener('touchcancel', this.onTouchEnd, { passive: true });
        window.addEventListener('resize', this.onResize);
    }

    unbindEvents() {
        this.touchHelper?.destroy();
        this.mediaElement?.removeEventListener('close', this.onDialogClosed);
        document.removeEventListener('keydown', this.onWindowKeyDown);
        this.container?.removeEventListener('wheel', this.onWheel);
        this.container?.removeEventListener('scroll', this.onScroll);
        this.container?.removeEventListener('pointerdown', this.onPointerDown);
        this.container?.removeEventListener('touchstart', this.onTouchStart);
        this.container?.removeEventListener('touchmove', this.onTouchMove);
        this.container?.removeEventListener('touchend', this.onTouchEnd);
        this.container?.removeEventListener('touchcancel', this.onTouchEnd);
        this.pinch = null;
        this.lastTap = null;
        window.removeEventListener('resize', this.onResize);
        this.intersectionObserver?.disconnect();
        this.intersectionObserver = null;
        clearTimeout(this.resizeTimeout);
        cancelAnimationFrame(this.scrollFrame);
        this.scrollFrame = null;
    }

    toggleFullscreen() {
        // the resize event picks up the new size, this is a fallback for browsers that resize late
        setTimeout(() => this.loaded && this.layout(), 200);
    }

    createMediaElement(options) {
        let elem = this.mediaElement;
        if (elem) {
            return elem;
        }

        elem = document.getElementById('pdfPlayer');
        if (!elem) {
            elem = dialogHelper.createDialog({
                exitAnimationDuration: 400,
                size: 'fullscreen',
                autoFocus: false,
                scrollY: false,
                exitAnimation: 'fadeout',
                removeOnClose: true
            });

            elem.id = 'pdfPlayer';
            elem.innerHTML = '<div id="bookOsdMount"></div><div id="container"><div class="pdfPages"></div></div>';

            dialogHelper.open(elem);
        }

        this.mediaElement = elem;
        this.container = elem.querySelector('#container');
        this.pagesElem = elem.querySelector('.pdfPages');

        this.unmountBookOsd = renderComponent(PdfOsd, {
            item: options.items[0],
            onExit: this.onDialogClosed,
            onPrevious: this.previous,
            onNext: this.next,
            onToggleFullscreen: this.toggleFullscreen,
            progressBar: React.createElement(PdfPageSlider, { player: this }),
            toolbarItems: React.createElement(PdfToolbar, { player: this })
        }, elem.querySelector('#bookOsdMount'));

        return elem;
    }

    setCurrentSrc(elem, options) {
        const item = options.items[0];

        this.item = item;
        this.streamInfo = {
            started: true,
            ended: false,
            item: this.item,
            mediaSource: {
                Id: item.Id
            }
        };

        return import('pdfjs-dist').then(({ GlobalWorkerOptions, getDocument }) => {
            const apiClient = ServerConnections.getApiClient(item.ServerId);
            const downloadHref = apiClient.getItemDownloadUrl(item.Id);

            this.bindEvents();
            GlobalWorkerOptions.workerSrc = appRouter.baseUrl() + '/libraries/pdf.worker.js';

            const downloadTask = getDocument({
                url: downloadHref,
                // 12.x servers ignore the api_key parameter in the download URL, the header works everywhere
                httpHeaders: { Authorization: `MediaBrowser Token="${apiClient.accessToken()}"` },
                // Only request the byte ranges needed for the pages being viewed instead of
                // downloading the whole document in the background, so large books open fast
                // and seeking to any page does not wait for the pages before it
                disableAutoFetch: true,
                disableStream: true,
                rangeChunkSize: RANGE_CHUNK_SIZE,
                // Disable for PDF.js XSS vulnerability
                // https://github.com/mozilla/pdf.js/security/advisories/GHSA-wgrm-67xf-hhpq
                isEvalSupported: false
            });
            return downloadTask.promise.then(book => {
                if (this.cancellationToken) {
                    book.destroy();
                    return;
                }

                this.currentSrc = () => downloadHref;
                this.book = book;

                return book.getPage(1).then(page => {
                    if (this.cancellationToken) return;

                    const viewport = page.getViewport({ scale: 1 });
                    this.defaultPageSize = { width: viewport.width, height: viewport.height };
                    this.pageSizes[1] = this.defaultPageSize;
                    this.loaded = true;

                    const startPage = Math.floor((options.startPositionTicks || 0) / 10000) + 1;
                    this.page = this.normalizePage(clamp(startPage, 1, book.numPages));
                    this.progress = this.page - 1;

                    this.layout();
                    this.notifyViewState();
                    this.loadChapters(book);
                });
            }).catch(err => {
                if (this.cancellationToken) return;
                console.error('[PdfPlayer] failed to load document', err);
                this.onLoadError();
            });
        });
    }

    /** Reads the chapters from the document outline, they show up once their pages are known. */
    loadChapters(book) {
        book.getOutline().then(outline => {
            let items = outline || [];
            // documents often wrap everything in a single root entry, its children are the chapters
            while (items.length === 1 && items[0].items?.length) items = items[0].items;

            const entries = [];
            const flatten = (list, level) => {
                for (const entry of list) {
                    entries.push({ title: entry.title, dest: entry.dest, level });
                    if (entry.items?.length) flatten(entry.items, level + 1);
                }
            };
            flatten(items, 0);

            return Promise.all(entries.map(entry => this.getDestinationPage(book, entry.dest).catch(() => null)))
                .then(pages => {
                    if (this.book !== book) return;

                    this.chapters = entries
                        .map((entry, i) => ({ title: entry.title, level: entry.level, page: pages[i] }))
                        .filter(chapter => chapter.page);
                    this.notifyViewState();
                });
        }).catch(err => {
            console.warn('[PdfPlayer] failed to read the document outline', err);
        });
    }

    /** Returns the page number an outline destination points to, or null for links and broken entries. */
    getDestinationPage(book, dest) {
        return Promise.resolve(typeof dest === 'string' ? book.getDestination(dest) : dest).then(explicit => {
            if (!Array.isArray(explicit)) return null;

            // the target is either a page object reference or a page index
            const target = explicit[0];
            if (Number.isInteger(target)) return target + 1;
            return book.getPageIndex(target).then(index => index + 1);
        });
    }

    /** Closes the reader and tells the user, instead of leaving an empty screen behind. */
    onLoadError() {
        this.stop();
        alert(globalize.translate('MessageFileReadError'));
    }

    // --- navigation ---

    /** Returns the first page of the spread containing the page, the cover page is shown alone. */
    getSpreadStart(number) {
        if (number <= 1) return 1;
        return number % 2 === 0 ? number : number - 1;
    }

    normalizePage(number) {
        return this.viewMode === 'spread' ? this.getSpreadStart(number) : number;
    }

    getVisiblePages() {
        if (this.viewMode === 'single') return [this.page];

        if (this.viewMode === 'spread') {
            const start = this.getSpreadStart(this.page);
            if (start === 1 || start + 1 > this.duration()) return [start];
            return [start, start + 1];
        }

        const pages = [];
        for (let i = 1; i <= this.duration(); i++) pages.push(i);
        return pages;
    }

    next() {
        if (!this.loaded) return;

        let target = this.page + 1;
        if (this.viewMode === 'spread') {
            const start = this.getSpreadStart(this.page);
            target = start === 1 ? 2 : start + 2;
        }

        if (target > this.duration()) return;
        this.goToPage(target);
    }

    previous() {
        if (!this.loaded) return;

        let target = this.page - 1;
        if (this.viewMode === 'spread') {
            const start = this.getSpreadStart(this.page);
            target = start <= 2 ? 1 : start - 2;
        }

        if (target < 1 || target === this.page) return;
        this.goToPage(target);
    }

    seek(number) {
        if (!this.loaded) return;
        this.goToPage(clamp(Math.round(number), 1, this.duration()));
    }

    goToPage(number) {
        const page = this.normalizePage(number);

        if (this.viewMode === 'continuous') {
            const entry = this.pageElements.get(page);
            if (entry) this.container.scrollTop = this.getPageOffset(entry.wrapper) - PAGE_GAP;
            this.setCurrentPage(page);
            return;
        }

        if (page === this.page) return;
        this.setCurrentPage(page);
        this.layout();
    }

    setCurrentPage(number) {
        if (number === this.page) return;

        this.page = number;
        this.progress = number - 1;
        this.notifyViewState();

        Events.trigger(this, 'pause');
    }

    updateCurrentPageFromScroll() {
        const pages = this.getVisiblePages();
        if (!pages.length) return;

        const container = this.container;
        if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) {
            this.setCurrentPage(pages[pages.length - 1]);
            return;
        }

        // the current page is the last one whose top is above the middle of the screen
        const threshold = container.scrollTop + container.clientHeight / 2;
        let low = 0;
        let high = pages.length - 1;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            const entry = this.pageElements.get(pages[mid]);
            if (entry && this.getPageOffset(entry.wrapper) <= threshold) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }

        this.setCurrentPage(pages[low]);
    }

    getPageOffset(wrapper) {
        return this.pagesElem.offsetTop + wrapper.offsetTop;
    }

    // --- zoom ---

    zoomIn() {
        this.setZoom(this.zoom * ZOOM_STEP);
    }

    zoomOut() {
        this.setZoom(this.zoom / ZOOM_STEP);
    }

    resetZoom() {
        this.setZoom(1);
    }

    /**
     * Changes the zoom level while keeping the point under the anchor (in client coordinates) in place.
     */
    setZoom(zoom, anchor) {
        if (!this.loaded) return;

        const newZoom = clamp(zoom, ZOOM_MIN, ZOOM_MAX);
        if (Math.abs(newZoom - this.zoom) < 0.001) return;

        const container = this.container;
        const rect = container.getBoundingClientRect();
        const offsetX = (anchor ? anchor.x : rect.left + rect.width / 2) - rect.left;
        const offsetY = (anchor ? anchor.y : rect.top + rect.height / 2) - rect.top;
        const contentX = container.scrollLeft + offsetX;
        const contentY = container.scrollTop + offsetY;

        const oldScale = this.scale;
        this.zoom = newZoom;
        this.scale = this.getFitScale() * this.zoom;
        this.applyPageSizes();

        const ratio = this.scale / oldScale;
        container.scrollLeft = contentX * ratio - offsetX;
        container.scrollTop = contentY * ratio - offsetY;

        this.scheduleRerender();
        this.notifyViewState();
    }

    // --- view modes ---

    setViewMode(mode) {
        if (!VIEW_MODES.includes(mode) || mode === this.viewMode) return;

        this.viewMode = mode;
        userSettings.set(VIEW_MODE_SETTING, mode, false);

        if (this.loaded) {
            const page = this.normalizePage(this.page);
            this.setCurrentPage(page);
            this.layout();
        }

        this.notifyViewState();
    }

    // --- layout and rendering ---

    getPageSize(number) {
        return this.pageSizes[number] || this.defaultPageSize;
    }

    /** Scale at which the visible pages fit the screen, zoom is applied on top of it. */
    getFitScale() {
        const availableWidth = Math.max(this.container.clientWidth - PAGE_GAP * 2, 1);
        const availableHeight = Math.max(this.container.clientHeight - PAGE_GAP * 2, 1);

        if (this.viewMode === 'continuous') {
            return Math.min(availableWidth, CONTINUOUS_MAX_WIDTH) / this.defaultPageSize.width;
        }

        const sizes = this.getVisiblePages().map(number => this.getPageSize(number));
        const totalWidth = sizes.reduce((width, size) => width + size.width, 0) + PAGE_GAP * (sizes.length - 1);
        const maxHeight = Math.max(...sizes.map(size => size.height));

        return Math.min(availableWidth / totalWidth, availableHeight / maxHeight);
    }

    /** Rebuilds the page elements for the current view mode and page. */
    layout() {
        if (!this.loaded || !this.pagesElem) return;

        clearTimeout(this.rerenderTimeout);
        this.releaseAllPages();
        this.intersectionObserver?.disconnect();
        this.pagesElem.innerHTML = '';
        this.pagesElem.className = `pdfPages pdfPages-${this.viewMode}`;

        const pages = this.getVisiblePages();
        this.scale = this.getFitScale() * this.zoom;

        const fragment = document.createDocumentFragment();
        for (const number of pages) {
            const wrapper = document.createElement('div');
            wrapper.className = 'pdfPage';
            wrapper.dataset.page = number;
            fragment.appendChild(wrapper);
            this.pageElements.set(number, { number, wrapper });
        }
        this.pagesElem.appendChild(fragment);
        this.applyPageSizes();

        if (this.viewMode === 'continuous') {
            // render pages lazily as they scroll into view and free the ones far away
            this.intersectionObserver = new IntersectionObserver(this.onPagesIntersect.bind(this), {
                root: this.container,
                rootMargin: '100% 0px'
            });
            for (const entry of this.pageElements.values()) {
                this.intersectionObserver.observe(entry.wrapper);
            }

            const current = this.pageElements.get(this.page);
            this.container.scrollTop = current ? this.getPageOffset(current.wrapper) - PAGE_GAP : 0;
        } else {
            this.container.scrollTop = 0;
            this.container.scrollLeft = 0;

            for (const entry of this.pageElements.values()) {
                this.renderPage(entry);
            }
            this.prefetchPages();
        }
    }

    onPagesIntersect(entries) {
        for (const { target, isIntersecting } of entries) {
            const entry = this.pageElements.get(parseInt(target.dataset.page, 10));
            if (!entry) continue;

            entry.visible = isIntersecting;
            if (isIntersecting) {
                this.renderPage(entry);
            } else {
                this.releasePage(entry);
            }
        }
    }

    applyPageSizes() {
        for (const entry of this.pageElements.values()) {
            const size = this.getPageSize(entry.number);
            entry.wrapper.style.width = `${Math.floor(size.width * this.scale)}px`;
            entry.wrapper.style.height = `${Math.floor(size.height * this.scale)}px`;
        }
    }

    scheduleRerender() {
        clearTimeout(this.rerenderTimeout);
        this.rerenderTimeout = setTimeout(() => {
            for (const entry of this.pageElements.values()) {
                if (this.viewMode !== 'continuous' || entry.visible) this.renderPage(entry);
            }
            if (this.viewMode !== 'continuous') this.prefetchPages();
        }, RERENDER_DELAY);
    }

    /** Renders the pages around the current spread into the cache so page turns are instant. */
    prefetchPages() {
        const step = this.viewMode === 'spread' ? 2 : 1;
        const visible = this.getVisiblePages();
        const first = visible[0];
        const last = visible[visible.length - 1];

        const pages = [];
        for (let i = 1; i <= PREFETCH_PAGES * step; i++) {
            if (last + i <= this.duration()) pages.push(last + i);
        }
        for (let i = 1; i <= step; i++) {
            if (first - i >= 1) pages.push(first - i);
        }

        const scale = this.scale;
        // render sequentially so the visible pages get the worker first
        const prefetchNext = () => {
            const number = pages.shift();
            if (number === undefined || this.cancellationToken || scale !== this.scale) return;

            this.drawPage(number, scale)
                .catch(() => { /* ignore prefetch failures */ })
                .then(prefetchNext);
        };
        prefetchNext();
    }

    getCacheKey(number, scale) {
        return `${number}@${scale.toFixed(4)}`;
    }

    /** Draws a page at the given CSS scale into a new canvas, cached for reuse. */
    drawPage(number, scale, onTask) {
        const key = this.getCacheKey(number, scale);
        const cached = this.canvasCache.get(key);
        if (cached) {
            // move to the end so it is evicted last
            this.canvasCache.delete(key);
            this.canvasCache.set(key, cached);
            return cached.promise;
        }

        const promise = this.book.getPage(number).then(page => {
            this.updatePageSize(number, page);

            const original = page.getViewport({ scale });
            const devicePixelRatio = window.devicePixelRatio || 1;
            const outputScale = Math.min(devicePixelRatio, Math.sqrt(MAX_CANVAS_PIXELS / (original.width * original.height)));
            const viewport = page.getViewport({ scale: scale * outputScale });

            const canvas = document.createElement('canvas');
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);

            const renderTask = page.render({
                canvasContext: canvas.getContext('2d'),
                viewport
            });
            onTask?.(renderTask);

            return renderTask.promise.then(() => canvas);
        });

        const cacheEntry = { promise, pixels: 0 };
        this.canvasCache.set(key, cacheEntry);
        promise.then(canvas => {
            cacheEntry.pixels = canvas.width * canvas.height;
            this.trimCanvasCache();
        }, () => {
            if (this.canvasCache.get(key) === cacheEntry) this.canvasCache.delete(key);
        });
        this.trimCanvasCache();

        return promise;
    }

    trimCanvasCache() {
        let pixels = 0;
        for (const entry of this.canvasCache.values()) pixels += entry.pixels;

        // evict the least recently used canvases, always keeping the newest one
        for (const [key, entry] of this.canvasCache) {
            if (this.canvasCache.size <= 1) break;
            if (this.canvasCache.size <= CANVAS_CACHE_SIZE && pixels <= CANVAS_CACHE_PIXELS) break;

            this.canvasCache.delete(key);
            pixels -= entry.pixels;
        }
    }

    updatePageSize(number, page) {
        if (this.pageSizes[number]) return;

        const viewport = page.getViewport({ scale: 1 });
        const size = { width: viewport.width, height: viewport.height };
        this.pageSizes[number] = size;

        const entry = this.pageElements.get(number);
        const fallback = this.defaultPageSize;
        if (!entry || (size.width === fallback.width && size.height === fallback.height)) return;

        if (this.viewMode === 'continuous') {
            // keep the scroll position stable when a page above the screen changes height
            const above = this.getPageOffset(entry.wrapper) < this.container.scrollTop;
            const oldHeight = entry.wrapper.offsetHeight;
            this.applyPageSizes();
            if (above) this.container.scrollTop += entry.wrapper.offsetHeight - oldHeight;
        } else {
            // pages with a different size change the scale needed to fit them
            this.scale = this.getFitScale() * this.zoom;
            this.applyPageSizes();
            this.scheduleRerender();
        }
    }

    renderPage(entry) {
        const scale = this.scale;
        if (entry.renderedScale === scale || entry.pendingScale === scale) return;

        entry.renderTask?.cancel();
        entry.renderTask = null;
        entry.pendingScale = scale;

        this.drawPage(entry.number, scale, task => {
            entry.renderTask = task;
        }).then(canvas => {
            entry.renderTask = null;
            if (this.cancellationToken || entry.pendingScale !== scale || this.pageElements.get(entry.number) !== entry) return;

            entry.pendingScale = null;
            entry.renderedScale = scale;

            // a cached canvas can only be shown in one place at a time
            const source = canvas.parentNode ? this.cloneCanvas(canvas) : canvas;
            if (entry.canvas) {
                entry.wrapper.replaceChild(source, entry.canvas);
            } else {
                entry.wrapper.appendChild(source);
            }
            entry.canvas = source;

            loading.hide();
        }).catch(err => {
            if (entry.pendingScale === scale) entry.pendingScale = null;
            if (this.cancellationToken) return;
            if (err?.name !== 'RenderingCancelledException') {
                console.error('[PdfPlayer] failed to render page', entry.number, err);
                loading.hide();
            }
        });
    }

    cloneCanvas(canvas) {
        const clone = document.createElement('canvas');
        clone.width = canvas.width;
        clone.height = canvas.height;
        clone.getContext('2d').drawImage(canvas, 0, 0);
        return clone;
    }

    releasePage(entry) {
        entry.renderTask?.cancel();
        entry.renderTask = null;
        entry.pendingScale = null;
        entry.renderedScale = null;
        entry.canvas?.remove();
        entry.canvas = null;
    }

    releaseAllPages() {
        if (!this.pageElements) return;

        for (const entry of this.pageElements.values()) {
            // cancelling a shared render task would break the cached canvas for the next layout
            entry.renderTask = null;
            this.releasePage(entry);
        }
        this.pageElements.clear();
    }

    canPlayMediaType(mediaType) {
        return (mediaType || '').toLowerCase() === 'book';
    }

    canPlayItem(item) {
        return item.Path ? item.Path.toLowerCase().endsWith('pdf') : false;
    }
}

export default PdfPlayer;
